/**
 * Task 1c — workspace isolation & roles access-control tests.
 *
 * These are *integration* tests: they exercise real Supabase Auth + RLS, not
 * mocks, because the whole point of Task 1c is that the rules hold at the
 * database level even when the client is bypassed.
 *
 * Setup:
 *   - `beforeAll` creates real test users via `service.auth.admin.createUser`
 *     using the service-role key, server-side / in test config only, NEVER
 *     in app code, and seeds `memberships` linking them to two workspaces.
 *   - Each user is then signed in with the anon client (createClient(url,
 *     ANON_KEY)) so their queries run under RLS as that user.
 *   - Point this at a disposable/local Supabase project, **NEVER** production.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'

const ACME = '11111111-1111-1111-1111-111111111111'
const GLOBEX = '22222222-2222-2222-2222-222222222222'

const supabaseUrl =
  process.env.SUPABASE_URL ?? import.meta.env.VITE_SUPABASE_URL
const anonKey =
  process.env.SUPABASE_ANON_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY

// Avoid exposing the service role key to the client with VITE_ prefix. Use this
// simple file read instead of a library (like dotenv) for now.
const envFile = fs.readFileSync(
  path.join(import.meta.dirname, '../../.env'),
  'utf8',
)
const serviceRoleKeyMatch = envFile.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m)
const serviceRoleKey = serviceRoleKeyMatch
  ? serviceRoleKeyMatch[1].trim()
  : undefined

const runId = `rls-${Date.now()}`
const password = 'TestPassword123!'

type TestUser = {
  id: string
  email: string
}

let service: SupabaseClient
let adminAcme: SupabaseClient
let memberAcme: SupabaseClient
let viewerAcme: SupabaseClient
let viewerGlobex: SupabaseClient

let adminUser: TestUser
let memberUser: TestUser
let viewerUser: TestUser
let globexUser: TestUser
let targetUser: TestUser
let viewerProbeTaskId: string

function client(key: string) {
  return createClient(supabaseUrl, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

async function createTestUser(label: string): Promise<TestUser> {
  const email = `${runId}-${label}@example.com`

  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  expect(error).toBeNull()
  expect(data.user).not.toBeNull()

  return {
    id: data.user!.id,
    email,
  }
}

async function signInAs(user: TestUser) {
  const signedIn = client(anonKey)

  const { error } = await signedIn.auth.signInWithPassword({
    email: user.email,
    password,
  })

  expect(error).toBeNull()

  return signedIn
}

function expectDenied(result: { error: unknown; data: unknown[] | null }) {
  expect(Boolean(result.error) || result.data?.length === 0).toBe(true)
}

beforeAll(async () => {
  expect(supabaseUrl).toBeTruthy()
  expect(anonKey).toBeTruthy()
  expect(serviceRoleKey).toBeTruthy()

  service = client(serviceRoleKey!)

  const { data: workspaces, error: workspacesError } = await service
    .from('workspaces')
    .select('id')
    .in('id', [ACME, GLOBEX])

  expect(workspacesError).toBeNull()
  expect(workspaces).toHaveLength(2)

  adminUser = await createTestUser('admin-acme')
  memberUser = await createTestUser('member-acme')
  viewerUser = await createTestUser('viewer-acme')
  globexUser = await createTestUser('viewer-globex')
  targetUser = await createTestUser('target')

  const { error: membershipsError } = await service.from('memberships').insert([
    { user_id: adminUser.id, workspace_id: ACME, role: 'admin' },
    { user_id: memberUser.id, workspace_id: ACME, role: 'member' },
    { user_id: viewerUser.id, workspace_id: ACME, role: 'viewer' },
    { user_id: globexUser.id, workspace_id: GLOBEX, role: 'viewer' },
  ])

  expect(membershipsError).toBeNull()

  const { data: probeTask, error: probeTaskError } = await service
    .from('tasks')
    .insert({
      workspace_id: ACME,
      title: `${runId} viewer probe`,
      status: 'todo',
    })
    .select('id')
    .single()

  expect(probeTaskError).toBeNull()
  viewerProbeTaskId = probeTask?.id ?? ''

  adminAcme = await signInAs(adminUser)
  memberAcme = await signInAs(memberUser)
  viewerAcme = await signInAs(viewerUser)
  viewerGlobex = await signInAs(globexUser)
})

afterAll(async () => {
  if (!service) return

  const userIds = [
    adminUser?.id,
    memberUser?.id,
    viewerUser?.id,
    globexUser?.id,
    targetUser?.id,
  ].filter(Boolean)

  await service.from('tasks').delete().ilike('title', `${runId}%`)
  await service.from('memberships').delete().in('user_id', userIds)

  for (const userId of userIds) {
    await service.auth.admin.deleteUser(userId)
  }
})

describe('workspace isolation & roles (RLS)', () => {
  it('a member of workspace A cannot read workspace B tasks', async () => {
    const crossWorkspace = await viewerGlobex
      .from('tasks')
      .select('id, workspace_id')
      .eq('workspace_id', ACME)

    expect(crossWorkspace.error).toBeNull()
    expect(crossWorkspace.data).toEqual([])

    const ownWorkspace = await viewerGlobex
      .from('tasks')
      .select('id')
      .eq('workspace_id', GLOBEX)
      .limit(1)

    expect(ownWorkspace.error).toBeNull()
    expect(ownWorkspace.data?.length).toBeGreaterThan(0)
  })

  it('a member of workspace A cannot write into workspace B', async () => {
    const result = await memberAcme
      .from('tasks')
      .insert({
        workspace_id: GLOBEX,
        title: `${runId} cross-workspace write`,
        status: 'todo',
      })
      .select('id')

    expectDenied(result)
  })

  it('a viewer cannot create, update, or delete tasks', async () => {
    const insertResult = await viewerAcme
      .from('tasks')
      .insert({
        workspace_id: ACME,
        title: `${runId} viewer insert`,
        status: 'todo',
      })
      .select('id')

    expectDenied(insertResult)

    const updateResult = await viewerAcme
      .from('tasks')
      .update({
        status: 'done',
        updated_at: new Date().toISOString(),
      })
      .eq('id', viewerProbeTaskId)
      .select('id')

    expectDenied(updateResult)

    const deleteResult = await viewerAcme
      .from('tasks')
      .delete()
      .eq('id', viewerProbeTaskId)
      .select('id')

    expectDenied(deleteResult)
  })

  it('a member can create and edit but cannot perform admin-only actions', async () => {
    const created = await memberAcme
      .from('tasks')
      .insert({
        workspace_id: ACME,
        title: `${runId} member task`,
        status: 'todo',
      })
      .select('id')
      .single()

    expect(created.error).toBeNull()
    expect(created.data).not.toBeNull()

    const updated = await memberAcme
      .from('tasks')
      .update({
        status: 'done',
        updated_at: new Date().toISOString(),
      })
      .eq('id', created.data!.id)
      .select('id, status')

    expect(updated.error).toBeNull()
    expect(updated.data).toHaveLength(1)
    expect(updated.data?.[0].status).toBe('done')

    const deleteResult = await memberAcme
      .from('tasks')
      .delete()
      .eq('id', created.data!.id)
      .select('id')

    expectDenied(deleteResult)

    const membershipResult = await memberAcme
      .from('memberships')
      .insert({
        user_id: targetUser.id,
        workspace_id: ACME,
        role: 'viewer',
      })
      .select('id')

    expectDenied(membershipResult)
  })

  it('an admin can manage members and all data within their workspace', async () => {
    const created = await adminAcme
      .from('tasks')
      .insert({
        workspace_id: ACME,
        title: `${runId} admin task`,
        status: 'todo',
      })
      .select('id')
      .single()

    expect(created.error).toBeNull()
    expect(created.data).not.toBeNull()

    const updated = await adminAcme
      .from('tasks')
      .update({
        status: 'done',
        updated_at: new Date().toISOString(),
      })
      .eq('id', created.data!.id)
      .select('id, status')

    expect(updated.error).toBeNull()
    expect(updated.data).toHaveLength(1)

    const deleted = await adminAcme
      .from('tasks')
      .delete()
      .eq('id', created.data!.id)
      .select('id')

    expect(deleted.error).toBeNull()
    expect(deleted.data).toHaveLength(1)

    const membership = await adminAcme
      .from('memberships')
      .insert({
        user_id: targetUser.id,
        workspace_id: ACME,
        role: 'viewer',
      })
      .select('id')
      .single()

    expect(membership.error).toBeNull()
    expect(membership.data).not.toBeNull()

    const crossWorkspaceTask = await adminAcme
      .from('tasks')
      .insert({
        workspace_id: GLOBEX,
        title: `${runId} admin cross-workspace task`,
        status: 'todo',
      })
      .select('id')

    expectDenied(crossWorkspaceTask)

    const crossWorkspaceMembership = await adminAcme
      .from('memberships')
      .insert({
        user_id: targetUser.id,
        workspace_id: GLOBEX,
        role: 'viewer',
      })
      .select('id')

    expectDenied(crossWorkspaceMembership)
  })
})
