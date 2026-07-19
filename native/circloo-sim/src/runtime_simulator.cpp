#include "runtime_simulator.h"

#include <algorithm>
#include <cmath>

namespace circloo {
namespace {

b2BodyType BodyType(std::int32_t type) {
    if (type <= static_cast<std::int32_t>(b2_staticBody)) {
        return b2_staticBody;
    }
    if (type >= static_cast<std::int32_t>(b2_dynamicBody)) {
        return b2_dynamicBody;
    }
    return b2_kinematicBody;
}

void SetFilter(b2FixtureDef& fixture, const ModelFilter& filter) {
    fixture.filter.categoryBits = filter.category_bits;
    fixture.filter.maskBits = filter.mask_bits;
    fixture.filter.groupIndex = filter.group_index;
}

std::vector<b2Vec2> BoxVertices(const std::vector<ModelVec2>& source) {
    std::vector<b2Vec2> result;
    result.reserve(source.size());
    for (const ModelVec2& vertex : source) {
        result.emplace_back(vertex.x, vertex.y);
    }
    return result;
}

[[noreturn]] void InvalidModel() {
    __builtin_trap();
}

} // namespace

RuntimeSimulator::RuntimeSimulator(const RuntimeModel& model)
    : model_(model),
      world_(b2Vec2(model.world.gravity.x, model.world.gravity.y)) {
    world_.SetAllowSleeping(model.world.allow_sleep);
    world_.SetWarmStarting(model.world.warm_starting);
    world_.SetContinuousPhysics(model.world.continuous_physics);
    world_.SetSubStepping(model.world.sub_stepping);
    world_.SetPreviousInverseTimeStep(model.world.step_rate);

    std::size_t maximum_body_count = model.bodies.size();
    for (const ModelWorldPatch& patch : model.growth_patches) {
        maximum_body_count += patch.spawned_bodies.size();
    }
    tags_.resize(maximum_body_count);
    bodies_.reserve(maximum_body_count);

    for (const ModelBody& body : model.bodies) {
        CreateBody(body);
    }
    for (const ModelJoint& joint : model.joints) {
        CreateJoint(joint);
    }
    if (model.player.body_index < 0 ||
        static_cast<std::size_t>(model.player.body_index) >= bodies_.size()) {
        InvalidModel();
    }
    player_ = bodies_[static_cast<std::size_t>(model.player.body_index)];
    world_.InitializeSnapshotContacts();
    RestoreBodyKinematics();
    RestoreContacts();

    state_.frame = model.lifecycle.initial_frame;
    state_.checkpoint = model.lifecycle.initial_checkpoint;
    state_.growth_alarm = model.lifecycle.initial_growth_alarm;
    state_.boundary_radius_pixels = model.lifecycle.initial_boundary_radius_pixels;
    state_.checkpoint_frames = model.lifecycle.checkpoint_frames;
    state_.collected.resize(model.collectibles.size(), 0U);
    for (std::size_t index = 0; index < model.collectibles.size(); ++index) {
        state_.collected[index] = model.collectibles[index].collected ? 1U : 0U;
    }
    while (next_growth_patch_ < model.growth_patches.size() &&
           model.growth_patches[next_growth_patch_].boundary_radius_pixels <=
               state_.boundary_radius_pixels) {
        ++next_growth_patch_;
    }
}

b2Fixture* RuntimeSimulator::FixtureAt(
    std::int32_t body_index,
    std::int32_t fixture_index
) {
    if (body_index < 0 || fixture_index < 0 ||
        static_cast<std::size_t>(body_index) >= bodies_.size()) {
        return nullptr;
    }
    b2Fixture* fixture = bodies_[static_cast<std::size_t>(body_index)]->GetFixtureList();
    for (std::int32_t index = 0; fixture && index < fixture_index; ++index) {
        fixture = fixture->GetNext();
    }
    return fixture;
}

void RuntimeSimulator::RestoreBodyKinematics() {
    if (model_.bodies.size() > bodies_.size()) {
        InvalidModel();
    }
    for (std::size_t index = 0; index < model_.bodies.size(); ++index) {
        const ModelBody& source = model_.bodies[index];
        b2Body* body = bodies_[index];
        body->SetAwake(source.awake);
        body->SetLinearVelocity(b2Vec2(source.linear_velocity.x, source.linear_velocity.y));
        body->SetAngularVelocity(source.angular_velocity);
        body->SetSleepTime(source.sleep_time);
    }
}

void RuntimeSimulator::RestoreContacts() {
    for (const ModelContact& source : model_.contacts) {
        b2Fixture* fixture_a = FixtureAt(source.body_a_index, source.fixture_a_index);
        b2Fixture* fixture_b = FixtureAt(source.body_b_index, source.fixture_b_index);
        if (!fixture_a || !fixture_b) {
            InvalidModel();
        }

        b2Contact* matched = nullptr;
        for (b2Contact* contact = world_.GetContactList(); contact; contact = contact->GetNext()) {
            if (contact->GetFixtureA() == fixture_a &&
                contact->GetChildIndexA() == source.child_a &&
                contact->GetFixtureB() == fixture_b &&
                contact->GetChildIndexB() == source.child_b) {
                matched = contact;
                break;
            }
        }
        if (!matched) {
            InvalidModel();
        }

        std::uint32_t ids[2]{};
        double normal_impulses[2]{};
        double tangent_impulses[2]{};
        for (std::int32_t index = 0; index < source.point_count; ++index) {
            ids[index] = source.points[static_cast<std::size_t>(index)].id;
            normal_impulses[index] =
                source.points[static_cast<std::size_t>(index)].normal_impulse;
            tangent_impulses[index] =
                source.points[static_cast<std::size_t>(index)].tangent_impulse;
        }
        matched->SetCapturedSolverState(
            source.flags,
            source.friction,
            source.restitution,
            source.tangent_speed,
            source.toi_count,
            source.toi,
            source.point_count,
            ids,
            normal_impulses,
            tangent_impulses
        );
    }
}

b2Joint* RuntimeSimulator::CreateJoint(const ModelJoint& source) {
    if (source.body_a_index < 0 || source.body_b_index < 0 ||
        static_cast<std::size_t>(source.body_a_index) >= bodies_.size() ||
        static_cast<std::size_t>(source.body_b_index) >= bodies_.size()) {
        InvalidModel();
    }
    b2Body* body_a = bodies_[static_cast<std::size_t>(source.body_a_index)];
    b2Body* body_b = bodies_[static_cast<std::size_t>(source.body_b_index)];

    switch (source.type) {
        case ModelJointType::Revolute: {
            b2RevoluteJointDef definition;
            definition.Initialize(
                body_a,
                body_b,
                b2Vec2(source.anchor_a.x, source.anchor_a.y)
            );
            definition.referenceAngle = source.reference_angle;
            definition.lowerAngle = source.lower_angle;
            definition.upperAngle = source.upper_angle;
            definition.maxMotorTorque = source.max_motor_torque;
            definition.motorSpeed = source.motor_speed;
            definition.collideConnected = source.collide_connected;
            definition.enableLimit = source.enable_limit;
            definition.enableMotor = source.enable_motor;
            auto* joint = static_cast<b2RevoluteJoint*>(world_.CreateJoint(&definition));
            joint->SetCapturedSolverState(
                source.impulse.x,
                source.impulse.y,
                source.impulse_z,
                source.motor_impulse,
                static_cast<b2LimitState>(source.limit_state)
            );
            return joint;
        }
        case ModelJointType::Rope: {
            b2RopeJointDef definition;
            definition.bodyA = body_a;
            definition.bodyB = body_b;
            definition.localAnchorA.Set(source.local_anchor_a.x, source.local_anchor_a.y);
            definition.localAnchorB.Set(source.local_anchor_b.x, source.local_anchor_b.y);
            definition.maxLength = source.max_length;
            definition.collideConnected = source.collide_connected;
            auto* joint = static_cast<b2RopeJoint*>(world_.CreateJoint(&definition));
            joint->SetCapturedSolverState(
                source.impulse.x,
                static_cast<b2LimitState>(source.limit_state)
            );
            return joint;
        }
    }
    InvalidModel();
}

b2Body* RuntimeSimulator::CreateBody(const ModelBody& source) {
    if (next_tag_index_ >= tags_.size()) {
        InvalidModel();
    }
    InstanceTag& tag = tags_[next_tag_index_++];
    tag.id = source.instance_id;
    tag.object_index = source.object_index;

    b2BodyDef definition;
    definition.type = BodyType(source.type);
    definition.position.Set(source.position.x, source.position.y);
    definition.angle = source.angle;
    definition.linearVelocity.Set(source.linear_velocity.x, source.linear_velocity.y);
    definition.angularVelocity = source.angular_velocity;
    definition.linearDamping = source.linear_damping;
    definition.angularDamping = source.angular_damping;
    definition.gravityScale = source.gravity_scale;
    definition.allowSleep = source.allow_sleep;
    definition.awake = source.awake;
    definition.active = source.active;
    definition.bullet = source.bullet;
    definition.fixedRotation = source.fixed_rotation;
    definition.userData = &tag;

    b2Body* body = world_.CreateBody(&definition);
    bodies_.push_back(body);
    for (const ModelFixture& fixture : source.fixtures) {
        CreateFixture(*body, fixture);
    }
    body->SetSleepTime(source.sleep_time);
    return body;
}

b2Fixture* RuntimeSimulator::CreateFixture(b2Body& body, const ModelFixture& source) {
    b2FixtureDef definition;
    definition.density = source.density;
    definition.friction = source.friction;
    definition.restitution = source.restitution;
    definition.isSensor = source.sensor;
    SetFilter(definition, source.filter);

    switch (source.shape.type) {
        case ModelShapeType::Circle: {
            b2CircleShape shape;
            shape.m_radius = source.shape.radius;
            shape.m_p.Set(source.shape.center.x, source.shape.center.y);
            definition.shape = &shape;
            return body.CreateFixture(&definition);
        }
        case ModelShapeType::Polygon: {
            if (source.shape.vertices.size() < 3U) {
                InvalidModel();
            }
            std::vector<b2Vec2> vertices = BoxVertices(source.shape.vertices);
            b2PolygonShape shape;
            shape.Set(vertices.data(), static_cast<std::int32_t>(vertices.size()));
            shape.m_radius = source.shape.radius;
            definition.shape = &shape;
            return body.CreateFixture(&definition);
        }
        case ModelShapeType::Edge: {
            if (source.shape.vertices.size() < 2U) {
                InvalidModel();
            }
            b2EdgeShape shape;
            shape.Set(
                b2Vec2(source.shape.vertices[0].x, source.shape.vertices[0].y),
                b2Vec2(source.shape.vertices[1].x, source.shape.vertices[1].y)
            );
            shape.m_radius = source.shape.radius;
            if (source.shape.has_previous_vertex) {
                shape.m_vertex0.Set(
                    source.shape.previous_vertex.x,
                    source.shape.previous_vertex.y
                );
                shape.m_hasVertex0 = true;
            }
            if (source.shape.has_next_vertex) {
                shape.m_vertex3.Set(
                    source.shape.next_vertex.x,
                    source.shape.next_vertex.y
                );
                shape.m_hasVertex3 = true;
            }
            definition.shape = &shape;
            return body.CreateFixture(&definition);
        }
        case ModelShapeType::Chain: {
            const std::size_t minimum = source.shape.loop ? 3U : 2U;
            if (source.shape.vertices.size() < minimum) {
                InvalidModel();
            }
            std::vector<b2Vec2> vertices = BoxVertices(source.shape.vertices);
            b2ChainShape shape;
            if (source.shape.loop) {
                shape.CreateLoop(vertices.data(), static_cast<std::int32_t>(vertices.size()));
            } else {
                shape.CreateChain(vertices.data(), static_cast<std::int32_t>(vertices.size()));
                if (source.shape.has_previous_vertex) {
                    shape.SetPrevVertex(b2Vec2(
                        source.shape.previous_vertex.x,
                        source.shape.previous_vertex.y
                    ));
                }
                if (source.shape.has_next_vertex) {
                    shape.SetNextVertex(b2Vec2(
                        source.shape.next_vertex.x,
                        source.shape.next_vertex.y
                    ));
                }
            }
            shape.m_radius = source.shape.radius;
            definition.shape = &shape;
            return body.CreateFixture(&definition);
        }
    }
    InvalidModel();
}

void RuntimeSimulator::ReplaceFixtures(
    b2Body& body,
    const std::vector<ModelFixture>& fixtures
) {
    while (body.GetFixtureList()) {
        body.DestroyFixture(body.GetFixtureList());
    }
    for (const ModelFixture& fixture : fixtures) {
        CreateFixture(body, fixture);
    }
}

void RuntimeSimulator::ApplyGrowthPatch(const ModelWorldPatch& patch) {
    if (patch.replace_body_index >= 0) {
        const std::size_t index = static_cast<std::size_t>(patch.replace_body_index);
        if (index >= bodies_.size()) {
            InvalidModel();
        }
        ReplaceFixtures(*bodies_[index], patch.replacement_fixtures);
    }
    for (const ModelBody& body : patch.spawned_bodies) {
        CreateBody(body);
    }
    state_.boundary_radius_pixels = patch.boundary_radius_pixels;
}

void RuntimeSimulator::AdvanceGrowthAlarm() {
    if (state_.growth_alarm == 0) {
        state_.growth_alarm = -1;
        return;
    }
    if (state_.growth_alarm < 0) {
        return;
    }

    --state_.growth_alarm;
    if (state_.growth_alarm != 0) {
        return;
    }

    if (next_growth_patch_ < model_.growth_patches.size()) {
        ApplyGrowthPatch(model_.growth_patches[next_growth_patch_]);
        ++next_growth_patch_;
    }
}

void RuntimeSimulator::CollectCurrentPosition() {
    const b2Vec2 player_position = player_->GetPosition();
    const double inverse_scale = 1.0 / model_.world.scale;
    const double player_x_pixels = player_position.x * inverse_scale;
    const double player_y_pixels = player_position.y * inverse_scale;

    for (std::size_t index = 0; index < model_.collectibles.size(); ++index) {
        if (state_.collected[index] != 0U) {
            continue;
        }
        const ModelCollectible& collectible = model_.collectibles[index];
        if (!collectible.active || collectible.excluded || !collectible.player_triggered) {
            continue;
        }

        double collectible_x = collectible.x_pixels;
        double collectible_y = collectible.y_pixels;
        if (collectible.body_index >= 0) {
            const std::size_t body_index = static_cast<std::size_t>(collectible.body_index);
            if (body_index >= bodies_.size()) {
                InvalidModel();
            }
            const b2Vec2 position = bodies_[body_index]->GetPosition();
            collectible_x = position.x * inverse_scale;
            collectible_y = position.y * inverse_scale;
        }

        const double dx = collectible_x - player_x_pixels;
        const double dy = collectible_y - player_y_pixels;
        const double distance_limit =
            collectible.radius_pixels + model_.player.collection_radius_pixels;
        const double distance = std::sqrt((dx * dx) + (dy * dy));
        if (!(distance < distance_limit)) {
            continue;
        }

        state_.collected[index] = 1U;
        if (collectible.counts_checkpoint) {
            ++state_.checkpoint;
            if (state_.checkpoint >= 0 &&
                static_cast<std::size_t>(state_.checkpoint) <
                    state_.checkpoint_frames.size()) {
                state_.checkpoint_frames[static_cast<std::size_t>(state_.checkpoint)] =
                    state_.frame + 1;
            }
        }
        if (
            collectible.starts_growth_alarm &&
            state_.boundary_radius_pixels < model_.lifecycle.maximum_boundary_radius_pixels
        ) {
            state_.growth_alarm = model_.lifecycle.growth_delay_frames;
        }
    }
}

void RuntimeSimulator::NudgeHorizontalVelocity(double amount) {
    b2Vec2 velocity = player_->GetLinearVelocity();
    const double inverse_scale = 1.0 / model_.world.scale;
    double game_velocity =
        (velocity.x * inverse_scale) / model_.player.room_speed;
    game_velocity += amount;
    velocity.x =
        game_velocity * model_.world.scale * model_.player.room_speed;
    player_->SetLinearVelocity(velocity);
    player_->SetAwake(true);
}

void RuntimeSimulator::ApplyInput(std::uint8_t input) {
    const double primary =
        model_.player.primary_acceleration * model_.player.input_scale;
    if ((input & 1U) != 0U) {
        NudgeHorizontalVelocity(-primary);
    }
    if ((input & 2U) != 0U) {
        NudgeHorizontalVelocity(primary);
    }
    if (!model_.player.secondary_acceleration_enabled) {
        return;
    }
    if ((input & 1U) != 0U) {
        NudgeHorizontalVelocity(-model_.player.secondary_acceleration);
    }
    if ((input & 2U) != 0U) {
        NudgeHorizontalVelocity(model_.player.secondary_acceleration);
    }
}

void RuntimeSimulator::Step(std::uint8_t input) {
    AdvanceGrowthAlarm();
    CollectCurrentPosition();
    ApplyInput(input);
    world_.Step(
        1.0 / model_.world.step_rate,
        model_.world.velocity_iterations,
        model_.world.position_iterations
    );
    world_.ClearForces();
    ++state_.frame;
}

} // namespace circloo
