import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import type { OwnerDraft, OwnerMutationRequest, OwnerQueryRequest, PreferencesPatchEntry, SessionPreferences } from '../../../src/generated/core';
import type { Session } from '../../../src/generated/domain/models';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { NavigationStore } from '../../../src/state/navigation/store';

const id = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;

it('loads saved navigation and drafts through real CLI/Core while pending recovery cannot publish main preferences', async () => {
  const cli = process.env.ARIADNE_FIXTURE_TEST_CLI ?? join(process.cwd(), 'target/debug/ariadne');
  expect(existsSync(cli), 'Build the CLI first: cargo build -p ariadne-cli --locked --offline').toBe(true);
  const root = await mkdtemp(join(tmpdir(), 'ariadne-pending-recovery-loading-'));
  const home = join(root, 'data'), project = join(root, 'project');
  await mkdir(home, { mode: 0o700 }); await mkdir(project);
  const env = { ...process.env, ARIADNE_HOME: home };
  const call = (args: string[], request?: OwnerQueryRequest | OwnerMutationRequest): unknown => {
    let output: string;
    try {
      output = execFileSync(cli, [...args, '--json'], { env, input: request ? JSON.stringify(request) : undefined,
        encoding: 'utf8', timeout: 15_000 });
    } catch (error: unknown) {
      // Typed Core rejection is returned in stdout even when the CLI exits nonzero.
      if (!error || typeof error !== 'object' || !('stdout' in error) || typeof error.stdout !== 'string') throw error;
      output = error.stdout;
    }
    return JSON.parse(output);
  };
  const commands: Record<string, string[]> = { preferences_get: ['preferences', 'get'], preferences_patch: ['preferences', 'patch'],
    project_list: ['project', 'list'], session_list: ['session', 'list'] };
  const transport: DesktopTransport = {
    async invoke<T>(command: string, { request }: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
      if (!commands[command]) throw new Error(`Unexpected CLI query: ${command}`);
      return call([...commands[command], '--json-stdin'], request) as T;
    },
    async listen() { return () => {}; },
  };
  const service = createDesktopService(transport);
  const patch = (operation: number, revision: number, entries: PreferencesPatchEntry[]): OwnerMutationRequest => ({ session: null,
    command: { api_version: 1, command: 'preferences_patch', op_id: id(operation),
      params: { expected_preferences_revision: revision, entries } } });
  const stores: NavigationStore[] = [];
  try {
    const demo = call(['demo', '--root', project]) as { ok: boolean; data: { project_id: string; session_id: string } };
    expect(demo.ok).toBe(true);
    const route = { project_id: demo.data.project_id, session_id: demo.data.session_id };
    const session = JSON.parse(await readFile(join(home, 'projects', route.project_id, 'sessions', `${route.session_id}.json`), 'utf8')) as Session;
    const topic = Object.values(session.topics)[0]!;
    const before = await service.query({ session: null, request: { command: 'preferences_get', params: {} } });
    const global = { ...before.global, theme: 'dark' as const, selected_navigation: { kind: 'project' as const, project_id: route.project_id } };
    const view: SessionPreferences = { session: route, tab_open: true, tab_order: 0, selected_item_id: '1', expanded_item_ids: ['1'],
      filters: { search: 'saved search', statuses: ['open'], owners: [], topic_id: null, archived: false, hide_later: true }, scroll: null };
    const draft: OwnerDraft = { op_id: id(1), session: route, binding_id: session.active_binding_id!, target: { topic_id: topic.id, item_id: null },
      intent: 'topic_reply', text: 'Keep my saved words\nAnd the trailing spaces  ', selected_option_id: null, target_revision: topic.revision,
      question_revision: null, supersedes_answer_id: null };
    await service.executeOwner(patch(2, before.revision, [{ kind: 'set_global', preferences: global },
      { kind: 'set_session_view', preferences: view }, { kind: 'upsert_draft', draft }]));
    const mainPath = join(home, 'ui.json'), companionPath = join(home, 'ui-recovery.json'), backupPath = join(home, 'ui.previous.json');
    const main = await readFile(mainPath);
    await rm(backupPath, { force: true }); await mkdir(backupPath);
    await expect(service.executeOwner(patch(3, before.revision + 1, [{ kind: 'resolve_unsent_input', input_id: id(4) }])))
      .rejects.toMatchObject({ error: { code: 'commit_uncertain' } });
    const companion = await readFile(companionPath);
    expect(JSON.parse(companion.toString())).toMatchObject({ resolved_input_ids: [id(4)],
      operations: [{ operation_id: id(3), result: { preferences_revision: before.revision + 2 } }] });
    for (let reload = 0; reload < 2; ++reload) {
      const navigation = new NavigationStore(service), drafts = new OwnerDraftStore(service);
      stores.push(navigation);
      await navigation.start(); await drafts.load();
      expect(navigation.getSnapshot()).toMatchObject({ status: 'ready', error: null, preferences: {
        revision: before.revision + 2, global, sessions: [view], resolved_unsent_input_ids: [id(4)],
      } });
      expect(drafts.getSnapshot()).toMatchObject({ ready: true, error: null });
      expect(drafts.findTopic(route, topic.id)?.draft).toEqual(draft);
      navigation.stop();
      expect(await readFile(mainPath)).toEqual(main);
      expect(await readFile(companionPath)).toEqual(companion);
    }
    await expect(service.executeOwner(patch(5, before.revision + 2, [{ kind: 'upsert_draft', draft: { ...draft, text: 'Replacement' } }])))
      .rejects.toMatchObject({ error: { code: 'commit_uncertain' } });
    expect(await readFile(mainPath)).toEqual(main);
    expect(await readFile(companionPath)).toEqual(companion);
  } finally {
    stores.forEach(store => store.stop());
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
