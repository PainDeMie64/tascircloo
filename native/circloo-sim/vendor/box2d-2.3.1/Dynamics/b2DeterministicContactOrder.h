#ifndef B2_DETERMINISTIC_CONTACT_ORDER_H
#define B2_DETERMINISTIC_CONTACT_ORDER_H

#include <Box2D/Dynamics/b2Body.h>
#include <Box2D/Dynamics/b2Fixture.h>
#include <Box2D/Dynamics/b2World.h>
#include <Box2D/Dynamics/Contacts/b2Contact.h>

#include <array>

namespace b2_deterministic_contact_order {

struct InstanceTagView
{
	int32 id;
	int32 objectIndex;
};

typedef std::array<int32, 5> EndpointKey;
typedef std::array<int32, 10> ContactKey;

inline int32 BodyOrdinal(const b2Body* body)
{
	if (body == NULL || body->GetWorld() == NULL)
	{
		return 0;
	}

	int32 ordinal = 0;
	for (const b2Body* current = body->GetWorld()->GetBodyList(); current && current != body;
		 current = current->GetNext())
	{
		++ordinal;
	}
	return ordinal;
}

inline int32 FixtureOrdinal(const b2Fixture* fixture)
{
	if (fixture == NULL || fixture->GetBody() == NULL)
	{
		return 0;
	}

	int32 ordinal = 0;
	for (const b2Fixture* current = fixture->GetBody()->GetFixtureList(); current && current != fixture;
		 current = current->GetNext())
	{
		++ordinal;
	}
	return ordinal;
}

inline EndpointKey MakeEndpointKey(const b2Fixture* fixture, int32 childIndex)
{
	const b2Body* body = fixture ? fixture->GetBody() : NULL;
	const InstanceTagView* tag = body
		? static_cast<const InstanceTagView*>(body->GetUserData())
		: NULL;
	EndpointKey key = {{
		tag ? tag->id : 0,
		tag ? tag->objectIndex : 0,
		BodyOrdinal(body),
		FixtureOrdinal(fixture),
		childIndex
	}};
	return key;
}

inline int CompareEndpointKeys(const EndpointKey& left, const EndpointKey& right)
{
	for (std::size_t index = 0; index < left.size(); ++index)
	{
		if (left[index] < right[index]) return -1;
		if (left[index] > right[index]) return 1;
	}
	return 0;
}

inline ContactKey MakeContactKey(const b2Contact* contact)
{
	EndpointKey endpointA = MakeEndpointKey(contact->GetFixtureA(), contact->GetChildIndexA());
	EndpointKey endpointB = MakeEndpointKey(contact->GetFixtureB(), contact->GetChildIndexB());
	if (CompareEndpointKeys(endpointA, endpointB) > 0)
	{
		const EndpointKey temporary = endpointA;
		endpointA = endpointB;
		endpointB = temporary;
	}

	ContactKey key;
	for (std::size_t index = 0; index < endpointA.size(); ++index)
	{
		key[index] = endpointA[index];
		key[index + endpointA.size()] = endpointB[index];
	}
	return key;
}

inline int CompareContactKeys(const ContactKey& left, const ContactKey& right)
{
	for (std::size_t index = 0; index < left.size(); ++index)
	{
		if (left[index] < right[index]) return -1;
		if (left[index] > right[index]) return 1;
	}
	return 0;
}

inline bool ContactDescending(const b2Contact* left, const b2Contact* right)
{
	return CompareContactKeys(MakeContactKey(left), MakeContactKey(right)) > 0;
}

} // namespace b2_deterministic_contact_order

#endif
