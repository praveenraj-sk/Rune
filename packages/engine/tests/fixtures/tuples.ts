/**
 * Reusable test tuple fixtures.
 *
 * Uses the Chennai logistics scenario as the primary demo dataset.
 * Consistent UUIDs ensure tests are deterministic across all runs.
 *
 * KEY: member = traversal relation (group membership, zone membership)
 *      viewer/editor/owner = access-granting relations
 */

// Fixed tenant UUIDs — never change these
export const LOGISTICS_TENANT = '11111111-1111-1111-1111-111111111111'
export const HOSPITAL_TENANT = '22222222-2222-2222-2222-222222222222'
export const FINANCE_TENANT = '33333333-3333-3333-3333-333333333333'
export const EMPTY_TENANT = '99999999-9999-9999-9999-999999999999'

// Chennai Logistics — core demo scenario
// BFS path: user:arjun → member → group:chennai_managers → owner → zone:chennai → viewer → shipment:TN001
export const logisticsTuples = [
    // Step 1: arjun is member of Chennai managers group
    { subject: 'user:arjun', relation: 'member', object: 'group:chennai_managers' },
    // Step 2: Chennai managers group owns the Chennai zone
    { subject: 'group:chennai_managers', relation: 'owner', object: 'zone:chennai' },
    // Step 3: zone:chennai grants viewer access to TN shipments (viewer = access-grant)
    { subject: 'zone:chennai', relation: 'viewer', object: 'shipment:TN001' },
    { subject: 'zone:chennai', relation: 'viewer', object: 'shipment:TN002' },

    // Mumbai zone — completely isolated from Chennai
    { subject: 'user:suresh', relation: 'member', object: 'group:mumbai_managers' },
    { subject: 'group:mumbai_managers', relation: 'owner', object: 'zone:mumbai' },
    { subject: 'zone:mumbai', relation: 'viewer', object: 'shipment:MH001' },

    // Admin has direct ownership of both zones
    { subject: 'user:admin_kumar', relation: 'owner', object: 'zone:chennai' },
    { subject: 'user:admin_kumar', relation: 'owner', object: 'zone:mumbai' },
]

// Hospital — Phase 1 complex test scenario
export const hospitalTuples = [
    { subject: 'user:dr_priya', relation: 'member', object: 'group:doctors' },
    { subject: 'user:nurse_raj', relation: 'member', object: 'group:nurses' },
    { subject: 'user:billing_meena', relation: 'member', object: 'group:billing' },
    { subject: 'group:doctors', relation: 'owner', object: 'patient:alice_record' },
    { subject: 'group:nurses', relation: 'viewer', object: 'patient:alice_record' },
    { subject: 'group:billing', relation: 'viewer', object: 'patient:alice_invoice' },
]
