#pragma once

#include <Box2D/Box2D.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "runtime_model.h"

namespace circloo {

struct InstanceTag {
    std::int32_t id = -1;
    std::int32_t object_index = -1;
};

struct RuntimeState {
    std::int32_t frame = 0;
    bool timer_started = false;
    std::int32_t checkpoint = 0;
    std::int32_t growth_alarm = -1;
    std::int32_t boundary_radius_pixels = 0;
    std::array<std::int32_t, 32> checkpoint_frames{};
    std::vector<std::uint8_t> collected{};
};

class RuntimeSimulator {
public:
    explicit RuntimeSimulator(const RuntimeModel& model);

    RuntimeSimulator(const RuntimeSimulator&) = delete;
    RuntimeSimulator& operator=(const RuntimeSimulator&) = delete;

    void Step(std::uint8_t input);

    [[nodiscard]] const RuntimeModel& model() const { return model_; }
    [[nodiscard]] const RuntimeState& state() const { return state_; }
    [[nodiscard]] b2Body& player() { return *player_; }
    [[nodiscard]] const b2Body& player() const { return *player_; }
    [[nodiscard]] b2World& world() { return world_; }
    [[nodiscard]] const b2World& world() const { return world_; }
    [[nodiscard]] const std::vector<b2Body*>& bodies() const { return bodies_; }
    [[nodiscard]] const std::vector<b2Joint*>& joints() const { return joints_; }

private:
    const RuntimeModel& model_;
    b2World world_;
    std::vector<InstanceTag> tags_{};
    std::vector<b2Body*> bodies_{};
    std::vector<b2Body*> initial_bodies_{};
    std::vector<b2Joint*> joints_{};
    b2Body* player_ = nullptr;
    RuntimeState state_{};
    std::size_t next_tag_index_ = 0;
    std::size_t next_checkpoint_patch_ = 0;
    std::size_t next_frame_patch_ = 0;
    std::size_t next_growth_patch_ = 0;
    std::vector<const ModelBody*> pending_growth_bodies_{};
    std::vector<ModelInstanceContact> pending_instance_contacts_{};

    b2Body* CreateBody(const ModelBody& source);
    b2Joint* CreateJoint(
        const ModelJoint& source,
        bool allow_missing_bodies = false
    );
    b2Fixture* CreateFixture(b2Body& body, const ModelFixture& source);
    b2Fixture* FixtureAt(std::int32_t body_index, std::int32_t fixture_index);
    b2Fixture* FixtureAt(b2Body* body, std::int32_t fixture_index);
    b2Body* FindBodyByInstanceId(std::int32_t instance_id);
    void RestoreContacts();
    void RestoreInstanceContacts(const std::vector<ModelInstanceContact>& contacts);
    void RetryPendingInstanceContacts();
    void RestoreBodyKinematics();
    void ReplaceFixtures(b2Body& body, const std::vector<ModelFixture>& fixtures);
    void ApplyGrowthPatch(const ModelWorldPatch& patch);
    void ApplyCheckpointPatches();
    void ApplyFramePatches(std::int32_t next_frame);
    void ApplyBodyUpdate(const ModelBodyUpdate& update);
    void ApplyBodyStateUpdate(const ModelBodyStateUpdate& update);
    void DestroyBodyByInstanceId(std::int32_t instance_id);
    void DestroyJoint(const ModelJointKey& key);
    void AdvanceGrowthAlarm();
    void CollectCurrentPosition(std::int32_t collection_frame);
    void NudgeHorizontalVelocity(double amount);
    void ApplyInput(std::uint8_t input);
};

} // namespace circloo
