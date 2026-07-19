#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace circloo {

struct ModelVec2 {
    double x = 0.0;
    double y = 0.0;
};

enum class ModelShapeType : std::int32_t {
    Circle = 0,
    Edge = 1,
    Polygon = 2,
    Chain = 3
};

struct ModelFilter {
    std::uint16_t category_bits = 0x0001;
    std::uint16_t mask_bits = 0xFFFF;
    std::int16_t group_index = 0;
};

struct ModelShape {
    ModelShapeType type = ModelShapeType::Circle;
    double radius = 0.0;
    ModelVec2 center{};
    std::vector<ModelVec2> vertices{};
    ModelVec2 previous_vertex{};
    ModelVec2 next_vertex{};
    bool has_previous_vertex = false;
    bool has_next_vertex = false;
    bool loop = false;
};

struct ModelFixture {
    ModelShape shape{};
    double density = 0.0;
    double friction = 0.2;
    double restitution = 0.0;
    bool sensor = false;
    ModelFilter filter{};
};

struct ModelBody {
    std::int32_t instance_id = -1;
    std::int32_t object_index = -1;
    std::int32_t type = 0;
    ModelVec2 position{};
    double angle = 0.0;
    ModelVec2 linear_velocity{};
    double angular_velocity = 0.0;
    double linear_damping = 0.0;
    double angular_damping = 0.0;
    double gravity_scale = 1.0;
    double sleep_time = 0.0;
    bool allow_sleep = true;
    bool awake = true;
    bool active = true;
    bool bullet = false;
    bool fixed_rotation = false;
    std::vector<ModelFixture> fixtures{};
};

struct ModelCollectible {
    std::int32_t instance_id = -1;
    std::int32_t object_index = -1;
    std::int32_t body_index = -1;
    double x_pixels = 0.0;
    double y_pixels = 0.0;
    double radius_pixels = 24.0;
    bool active = true;
    bool collected = false;
    bool excluded = false;
    bool counts_checkpoint = true;
    bool starts_growth_alarm = true;
    bool player_triggered = true;
};

enum class ModelJointType : std::int32_t {
    Revolute = 1,
    Rope = 10
};

struct ModelJoint {
    ModelJointType type = ModelJointType::Revolute;
    std::int32_t body_a_index = -1;
    std::int32_t body_b_index = -1;
    ModelVec2 anchor_a{};
    ModelVec2 anchor_b{};
    ModelVec2 local_anchor_a{};
    ModelVec2 local_anchor_b{};
    double reference_angle = 0.0;
    double lower_angle = 0.0;
    double upper_angle = 0.0;
    double max_motor_torque = 0.0;
    double motor_speed = 0.0;
    double max_length = 0.0;
    ModelVec2 impulse{};
    double impulse_z = 0.0;
    double motor_impulse = 0.0;
    std::int32_t limit_state = 0;
    bool collide_connected = false;
    bool enable_limit = false;
    bool enable_motor = false;
};

struct ModelContactPoint {
    ModelVec2 local_point{};
    double normal_impulse = 0.0;
    double tangent_impulse = 0.0;
    std::uint32_t id = 0;
};

struct ModelContact {
    std::int32_t body_a_index = -1;
    std::int32_t fixture_a_index = -1;
    std::int32_t child_a = 0;
    std::int32_t body_b_index = -1;
    std::int32_t fixture_b_index = -1;
    std::int32_t child_b = 0;
    std::uint32_t flags = 0;
    double friction = 0.0;
    double restitution = 0.0;
    double tangent_speed = 0.0;
    std::int32_t toi_count = 0;
    double toi = 0.0;
    std::int32_t manifold_type = 0;
    ModelVec2 local_normal{};
    ModelVec2 local_point{};
    std::array<ModelContactPoint, 2> points{};
    std::int32_t point_count = 0;
};

struct ModelWorldPatch {
    std::int32_t boundary_radius_pixels = 0;
    std::int32_t replace_body_index = -1;
    std::vector<ModelFixture> replacement_fixtures{};
    std::vector<ModelBody> spawned_bodies{};
};

struct ModelWorldSettings {
    ModelVec2 gravity{0.0, 35.0};
    double scale = 0.02;
    double step_rate = 60.0;
    std::int32_t velocity_iterations = 10;
    std::int32_t position_iterations = 10;
    bool allow_sleep = true;
    bool warm_starting = true;
    bool continuous_physics = true;
    bool sub_stepping = false;
};

struct ModelPlayerRules {
    std::int32_t body_index = -1;
    double room_speed = 60.0;
    double input_scale = 1.0;
    double primary_acceleration = 0.52;
    double secondary_acceleration = 0.01;
    bool secondary_acceleration_enabled = true;
    double collection_radius_pixels = 32.5;
};

struct ModelLifecycle {
    std::int32_t initial_frame = 0;
    std::int32_t initial_checkpoint = 0;
    std::int32_t initial_growth_alarm = -1;
    std::int32_t initial_boundary_radius_pixels = 200;
    std::int32_t maximum_boundary_radius_pixels = 1400;
    std::int32_t growth_delay_frames = 10;
    std::array<std::int32_t, 32> checkpoint_frames{};

    ModelLifecycle() {
        checkpoint_frames.fill(-1);
    }
};

struct RuntimeModel {
    ModelWorldSettings world{};
    ModelPlayerRules player{};
    ModelLifecycle lifecycle{};
    std::vector<ModelBody> bodies{};
    std::vector<ModelContact> contacts{};
    std::vector<ModelJoint> joints{};
    std::vector<ModelCollectible> collectibles{};
    std::vector<ModelWorldPatch> growth_patches{};
};

} // namespace circloo
