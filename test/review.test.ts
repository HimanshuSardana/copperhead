import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatOpts, Msg, Provider, Turn } from '../src/agent/types.js';
import { parseToolCalls } from '../src/agent/providers/tool-protocol.js';
import { CancelledError, normalizeProposal, type PassRecord, runPass } from '../src/review/pass.js';
import { digest, domainTask } from '../src/review/prompts.js';
import { replayReview, runReview } from '../src/review/run.js';
import { resolveTools, type ToolsClient, type ToolsResult } from '../src/review/tools-client.js';

/**
 * `copperhead review` (grounded review): the orchestration, with a scripted model and a fake
 * copperhead-tools. The deterministic tools are tested in copperhead-tools; here the contract is
 * what copperhead sends them, what the model sees, and what the record holds.
 */

function scriptedProvider(turns: Partial<Turn>[]): Provider & { seen: Msg[][]; closed: number } {
  let i = 0;
  const p = {
    name: 'scripted',
    seen: [] as Msg[][],
    closed: 0,
    async chat(messages: Msg[]): Promise<Turn> {
      p.seen.push([...messages]);
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      return { text: t.text ?? null, toolCalls: (t.toolCalls ?? []).map((c, j) => ({ ...c, id: `call-${i}-${j}` })), usage: t.usage ?? { inputTokens: 100, outputTokens: 10 } };
    },
    async close() {
      p.closed++;
    },
  };
  return p;
}

const BUNDLE = {
  format: 'copperhead-review-bundle',
  version: 1,
  label: 'fake board',
  design: { source: 'x.kicad_net', generator: 'test', components: [{ ref: 'U1', value: 'EXA', footprint: 'Lib:Pkg', dnp: false, fields: {} }], nets: [{ name: 'GND', nodes: [{ ref: 'U1', pin: '2', pinName: 'GND' }] }] },
  board: null,
  sweep: { findings: [{ severity: 'major', code: 'drc-triage.x', title: 'a sweep finding', evidenceClass: 'tool' }], envelope: [{ title: 'fabrication rules', examined: false, reason: 'no Gerbers' }] },
  sources: [{ id: 'ds/exa.txt', kind: 'datasheet', pages: 3 }],
  notes: [],
};

/** A copperhead-tools stand-in: records every request and answers each tool from a table. */
function fakeTools(): ToolsClient & { calls: { tool: string; inputs: Record<string, unknown> }[] } {
  const calls: { tool: string; inputs: Record<string, unknown> }[] = [];
  return {
    command: ['fake-tools'],
    calls,
    async run(tool, inputs): Promise<ToolsResult> {
      calls.push({ tool, inputs });
      const ok = (data: Record<string, unknown>, summary: Record<string, unknown> = {}): ToolsResult => ({ status: 'ok', tool: { id: tool, version: '0' }, package: { name: 'fake', version: '0' }, data, summary });
      if (tool === 'review') {
        await mkdir(String(inputs['out-dir']), { recursive: true });
        await writeFile(path.join(String(inputs['out-dir']), 'review.json'), '{}');
        return ok({}, { completed: 1 });
      }
      if (tool === 'review-bundle') {
        await writeFile(String(inputs.out), JSON.stringify(BUNDLE));
        return ok({ sha256: 'b'.repeat(64) }, { parts: 1 });
      }
      if (tool === 'review-query') return ok({ ok: true, text: `answer to ${String(inputs.op)} ${String(inputs.args ?? '')}` });
      if (tool === 'review-verify') {
        const doc = JSON.parse(await readFile(String(inputs.proposals), 'utf8')) as { proposals: { id: string; kind: string }[] };
        const verifications = doc.proposals.map((p) => ({ id: p.id, kind: p.kind, outcome: 'VERIFIED', class: 'VERIFIED', verifier: 'claim-check', reason: 'ok', claim: 'U1.2 is on GND' }));
        if (inputs.out) {
          await mkdir(String(inputs.out), { recursive: true });
          await writeFile(path.join(String(inputs.out), 'report.md'), `# report\n${doc.proposals.map((p) => p.id).join(', ')}\n`);
        }
        return ok({ verifications }, { proposals: verifications.length });
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  };
}

describe('review: the model\'s view', () => {
  it('reads the arguments of a call however the model names them', () => {
    const catalog = new Set(['search']);
    const parse = (raw: string) => parseToolCalls(raw, () => 'x', catalog).toolCalls[0]?.args;
    expect(parse('{"tool": "search", "args": {"pattern": "SDO"}}')).toEqual({ pattern: 'SDO' });
    expect(parse('{"tool": "search", "arguments": {"pattern": "SDO"}}')).toEqual({ pattern: 'SDO' });
    expect(parse('{"tool": "search", "pattern": "SDO", "source": "lis3dh"}')).toEqual({ pattern: 'SDO', source: 'lis3dh' });
    expect(parse('{"tool": "search"}')).toEqual({});
  });

  it('says why a call written as an <invoke> block did not run', () => {
    const catalog = new Set(['board', 'search']);
    const turn = parseToolCalls('<invoke name="board">\n</invoke>', () => 'x', catalog);
    expect(turn.toolCalls).toEqual([]);
    expect(turn.nudge).toMatch(/"board" was written as an <invoke> block[\s\S]*\{"tool": "board", "args"/);
    expect(parseToolCalls('<invoke name="shell">\n</invoke>', () => 'x', catalog).nudge).toBeUndefined();
    // A reply that also holds the call as JSON runs it, and needs no nudge.
    const mixed = parseToolCalls('<invoke name="search">\n</invoke>\n```json\n{"tool": "search", "args": {"pattern": "SDO"}}\n```', () => 'x', catalog);
    expect(mixed.toolCalls.map((c) => c.args)).toEqual([{ pattern: 'SDO' }]);
    expect(mixed.nudge).toBeUndefined();
  });

  it('shows the coverage gaps and every net in the bundle digest, and names the domain in the task', () => {
    const d = digest(BUNDLE);
    expect(d).toContain('GND: U1.2(GND)');
    expect(d).toContain('fabrication rules: no Gerbers');
    expect(d).toContain('[major] drc-triage.x');
    expect(domainTask('L', 30)).toMatch(/Your domain is L: physical\.[\s\S]*30 turns/);
  });

  it('prefixes proposal ids and their references with the domain', () => {
    expect(normalizeProposal('P', { id: 'F1', kind: 'finding', premises: ['C1', 'P.C2'] })).toMatchObject({ id: 'P.F1', domain: 'P', premises: ['P.C1', 'P.C2'] });
    expect(normalizeProposal('S', { id: 'K1', kind: 'calculation', inputs: { v: { value: '3.3 V', from: 'C1' }, r: { value: '10k', from: 'design:R1' }, x: { value: '1 V', from: 'assumption: y' } } }).inputs).toEqual({
      v: { value: '3.3 V', from: 'S.C1' },
      r: { value: '10k', from: 'design:R1' },
      x: { value: '1 V', from: 'assumption: y' },
    });
  });
});

describe('review: one pass', () => {
  it('queries through review-query, pre-checks proposals through review-verify, and ends on submit', async () => {
    const tools = fakeTools();
    const bundlePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'review-test-')), 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(BUNDLE));
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'net', args: { net: 'GND' } }] },
      { toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'P1', kind: 'fact', predicate: { 'pin-on-net': { pin: 'U1.2', net: 'GND' } } }] } }] },
      { toolCalls: [{ name: 'submit', args: { summary: 'done' } }] },
    ]);
    const rec = await runPass({ domain: 'P', model: 'scripted', provider, tools, bundlePath, system: 'sys', task: 'task', maxTurns: 10, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined });
    expect(rec).toMatchObject({ outcome: 'submitted', turns: 3, summary: 'done', proposals: [{ id: 'P.P1', domain: 'P' }] });
    expect(tools.calls.map((c) => c.tool)).toEqual(['review-query', 'review-verify']);
    expect(tools.calls[0]!.inputs).toMatchObject({ op: 'net', args: '{"net":"GND"}' });
    expect(rec.calls[1]!.result).toMatch(/^P\.P1: VERIFIED as VERIFIED \(claim-check\): ok/);
    expect(provider.closed).toBeGreaterThan(0);
  });

  it('retries a turn that times out once, and ends the pass on a second in a row', async () => {
    const tools = fakeTools();
    let calls = 0;
    const slowOnce: Provider = {
      name: 'slow',
      async chat(): Promise<Turn> {
        calls++;
        if (calls === 1) await new Promise((r) => setTimeout(r, 200));
        return { text: null, toolCalls: [{ id: `c${calls}`, name: 'submit', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const ok = await runPass({ domain: 'P', model: 's', provider: slowOnce, tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 50, log: () => undefined });
    expect(ok).toMatchObject({ outcome: 'submitted', turns: 2 });
    expect(ok.calls[0]!.tool).toBe('(timeout)');
    const never: Provider = { name: 'never', chat: () => new Promise(() => undefined) };
    const failed = await runPass({ domain: 'P', model: 's', provider: never, tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 20, log: () => undefined });
    expect(failed).toMatchObject({ outcome: 'failed', turns: 2, error: expect.stringMatching(/turn exceeded/) });
  });

  it('redacts API keys from the samples and proposals it writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    const out = path.join(root, 'record');
    const key = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    const quote = 'Non-solder-mask-defined (NSMD) pads are recommended.';
    const leaky = () => scriptedProvider([
      { text: `my key is ${key}`, toolCalls: [{ name: 'search', args: { pattern: key } }] },
      { toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'Q1', kind: 'question', text: `is ${key} valid?` }, { id: 'C1', kind: 'citation', source: 'ds/exa.txt', page: 1, quote }] } }] },
      { toolCalls: [{ name: 'submit', args: { summary: `found ${key} in the firmware` } }] },
    ]);
    const lines: string[] = [];
    await runReview({ design, out, sources: [], model: 's', domains: ['P'], maxTurns: 5, maxMinutes: 5, parallel: 1, makeProvider: async () => leaky(), log: (l) => lines.push(l), client: fakeTools() });
    for (const f of [path.join(out, 'model', 'samples', 'P.json'), path.join(out, 'model', 'proposals.json'), path.join(out, 'model', 'passes.json')]) {
      const text = await readFile(f, 'utf8');
      expect(text, f).not.toContain(key);
    }
    expect(JSON.parse(await readFile(path.join(out, 'model', 'passes.json'), 'utf8'))[0].summary).toBe('found [REDACTED] in the firmware');
    expect(lines.join('\n')).not.toContain(key);
    // Redaction must not garble a quotation the verifier compares verbatim.
    expect(JSON.parse(await readFile(path.join(out, 'model', 'proposals.json'), 'utf8')).proposals[1].quote).toBe(quote);
  }, 30_000);

  it('stops a pass that never calls a tool, and warns before the turns run out', async () => {
    const tools = fakeTools();
    const stalled = await runPass({ domain: 'M', model: 's', provider: scriptedProvider([{ text: 'thinking' }]), tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 10, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined });
    expect(stalled).toMatchObject({ outcome: 'stalled', turns: 3 });
    const p = scriptedProvider([{ toolCalls: [{ name: 'nets', args: {} }] }]);
    const out = await runPass({ domain: 'M', model: 's', provider: p, tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined });
    expect(out).toMatchObject({ outcome: 'turns-exhausted', turns: 5 });
    expect(p.seen.at(-1)!.some((m) => m.role === 'user' && /turns left/.test(m.content))).toBe(true);
  });

  it('saves the sample after every turn, a turn with no tool call and a timed-out one too', async () => {
    const saved: number[] = [];
    const onTurn = async (r: PassRecord) => void saved.push(r.turns);
    const idleFirst = scriptedProvider([{ text: 'thinking' }, { toolCalls: [{ name: 'submit', args: {} }] }]);
    await runPass({ domain: 'P', model: 's', provider: idleFirst, tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined, onTurn });
    expect(saved).toEqual([1, 2]);
    saved.length = 0;
    let n = 0;
    const slowFirst: Provider = {
      name: 'slow',
      async chat(): Promise<Turn> {
        if (++n === 1) await new Promise((r) => setTimeout(r, 200));
        return { text: null, toolCalls: [{ id: `c${n}`, name: 'submit', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    await runPass({ domain: 'P', model: 's', provider: slowFirst, tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 50, log: () => undefined, onTurn });
    expect(saved).toEqual([1, 2]);
  });

  it('does not time out a turn that keeps streaming, and retries a rate-limited one', async () => {
    const streaming: Provider = {
      name: 'streaming',
      async chat(_m: Msg[], _t, opts?: ChatOpts): Promise<Turn> {
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 30));
          opts?.onStream?.(i);
        }
        return { text: null, toolCalls: [{ id: 'c', name: 'submit', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    // 450 ms of streaming against a 150 ms inactivity timeout.
    const long = await runPass({ domain: 'P', model: 's', provider: streaming, tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 3, maxSeconds: 60, turnTimeoutMs: 150, turnMaxMs: 10_000, log: () => undefined });
    expect(long).toMatchObject({ outcome: 'submitted', turns: 1 });
    let calls = 0;
    const limited: Provider = {
      name: 'limited',
      async chat(): Promise<Turn> {
        if (++calls === 1) throw Object.assign(new Error('429 rate limited'), { status: 429 });
        return { text: null, toolCalls: [{ id: 'c', name: 'submit', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const lines: string[] = [];
    const rec = await runPass({ domain: 'P', model: 's', provider: limited, tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 3, maxSeconds: 60, turnTimeoutMs: 10_000, rateLimitBaseMs: 1, log: (l) => lines.push(l) });
    expect(rec).toMatchObject({ outcome: 'submitted', turns: 1 });
    expect(lines).toContain('[P] turn 1: rate limited; retry 1 of 3');
  });

  it('stops at once when cancelled, tearing the in-flight turn down', async () => {
    const cancel = new AbortController();
    let closed = 0;
    const hanging: Provider = {
      name: 'hanging',
      chat: () => {
        setTimeout(() => cancel.abort(), 20);
        return new Promise(() => undefined);
      },
      async close() {
        closed++;
      },
    };
    const t0 = Date.now();
    const rec = await runPass({ domain: 'P', model: 's', provider: hanging, tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 60_000, log: () => undefined, signal: cancel.signal });
    expect(rec).toMatchObject({ outcome: 'failed', error: 'cancelled', turns: 1 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(closed).toBeGreaterThan(0);
  });
});

describe('review: the run and its record', () => {
  it('runs the sweep, the bundle, a pass per domain and the verification, never writing the design', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    await writeFile(path.join(design, 'board.kicad_sch'), '(kicad_sch)');
    const tools = fakeTools();
    const script = (d: string) => scriptedProvider([
      { toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'P1', kind: 'fact', predicate: {} }] } }] },
      { toolCalls: [{ name: 'submit', args: { summary: d } }] },
    ]);
    let n = 0;
    const out = path.join(root, 'record');
    const res = await runReview({ design, out, sources: [], model: 'scripted', domains: ['P', 'L'], maxTurns: 5, maxMinutes: 5, parallel: 2, makeProvider: async () => script(String(n++)), log: () => undefined, client: tools });
    expect(res.passes.map((p) => [p.domain, p.outcome, p.proposals])).toEqual([['P', 'submitted', 1], ['L', 'submitted', 1]]);
    expect(await readdir(design)).toEqual(['board.kicad_sch']);
    expect(await readFile(path.join(out, 'report.md'), 'utf8')).toBe('# report\nP.P1, L.P1\n');
    const lock = JSON.parse(await readFile(path.join(out, 'review.lock.json'), 'utf8'));
    expect(lock).toMatchObject({ format: 'copperhead-review-lock', domains: ['P', 'L'], model: { id: 'scripted' } });
    expect(Object.keys(lock.templates.sha256)).toEqual(['rules', 'tools', 'task-P', 'task-L']);
    expect(await readdir(path.join(out, 'model', 'samples'))).toEqual(['L.json', 'P.json']);
    const replay = await replayReview(out, undefined, () => undefined, tools);
    expect(replay.identical).toBe(true);
    expect(tools.calls.filter((c) => c.tool === 'review-verify').at(-1)!.inputs.out).toBe(path.join(out, 'replay'));
    await writeFile(path.join(out, 'model', 'proposals.json'), '{"proposals": []}');
    await expect(replayReview(out, undefined, () => undefined, tools)).rejects.toThrow(/differs from the lockfile/);
  }, 30_000);

  it('resumes a killed run: keeps ended passes, reruns interrupted ones, reuses the bundle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    const out = path.join(root, 'record');
    const tools = fakeTools();
    const submitter = () => scriptedProvider([{ toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'P1', kind: 'fact', predicate: {} }] } }] }, { toolCalls: [{ name: 'submit', args: {} }] }]);
    const base = { design, out, sources: [], model: 's', maxTurns: 5, maxMinutes: 5, parallel: 1, log: () => undefined, client: tools };
    await runReview({ ...base, domains: ['P'], makeProvider: async () => submitter() });
    const sample = path.join(out, 'model', 'samples', 'L.json');
    await writeFile(sample, JSON.stringify({ domain: 'L', outcome: 'running', turns: 2, proposals: [] }));
    let made = 0;
    const res = await runReview({ ...base, domains: ['P', 'L'], resume: true, makeProvider: async () => (made++, submitter()) });
    expect(made).toBe(1);
    expect(res.passes.map((p) => [p.domain, p.outcome])).toEqual([['P', 'submitted'], ['L', 'submitted']]);
    expect(tools.calls.filter((c) => c.tool === 'review-bundle')).toHaveLength(1);
    expect((await readdir(path.join(out, 'model', 'samples'))).some((f) => f.startsWith('L.json.interrupted-'))).toBe(true);
  }, 30_000);

  it('prints the progress lines an editor extension parses', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    const lines: string[] = [];
    const submitter = () => scriptedProvider([{ toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'P1', kind: 'fact', predicate: {} }] } }] }, { toolCalls: [{ name: 'submit', args: {} }] }]);
    const failing = async () => {
      throw new Error('not logged in');
    };
    const base = { design, sources: [], model: 's', maxTurns: 5, maxMinutes: 5, parallel: 1, client: fakeTools() };
    await runReview({ ...base, out: path.join(root, 'a'), domains: ['P'], makeProvider: async () => submitter(), log: (l) => lines.push(l) });
    expect(lines[0]).toBe('sweep: copperhead-tools review (every applicable deterministic check)');
    expect(lines[1]).toBe('sweep: {"completed":1}');
    expect(lines[2]).toBe('bundle: {"parts":1}');
    expect(lines[3]).toBe('[P] pass starts (power)');
    expect(lines.at(-1)).toMatch(/^\[P\] pass ends: submitted after 2 turns, 1 proposals, \d+ s$/);
    lines.length = 0;
    // A pass whose provider cannot start still ends with a line, and leaves a sample.
    const res = await runReview({ ...base, out: path.join(root, 'b'), sweep: path.join(root, 'a', 'sweep'), domains: ['L'], makeProvider: failing, log: (l) => lines.push(l) });
    expect(lines[0]).toBe(`sweep: using the record at ${path.join(root, 'a', 'sweep')}`);
    expect(lines.slice(-2)).toEqual(['[L] pass starts (physical)', '[L] pass ends: failed after 0 turns, 0 proposals, 0 s (not logged in)']);
    expect(res.passes).toEqual([{ domain: 'L', outcome: 'failed', turns: 0, proposals: 0, seconds: 0, error: 'not logged in' }]);
    expect(JSON.parse(await readFile(path.join(root, 'b', 'model', 'samples', 'L.json'), 'utf8'))).toMatchObject({ outcome: 'failed' });
  }, 30_000);

  it('records paths inside the working directory relative to it, and still replays', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    await mkdir(path.join(root, 'board'));
    await mkdir(path.join(root, 'fab', 'gerbers'), { recursive: true });
    await writeFile(path.join(root, 'fab', 'jlc.yaml'), '');
    await writeFile(path.join(elsewhere, 'bom.csv'), '');
    const tools = fakeTools();
    await tools.run('review', { 'out-dir': path.join(root, 'sweep-record') });
    await runReview({
      cwd: root,
      design: 'board',
      out: 'reviews/r1',
      sweep: 'sweep-record',
      fab: ['fab/gerbers', path.join(elsewhere, 'bom.csv')],
      fabProfile: 'fab/jlc.yaml',
      sources: [],
      model: 's',
      domains: ['P'],
      maxTurns: 3,
      maxMinutes: 1,
      parallel: 1,
      makeProvider: async () => scriptedProvider([{ toolCalls: [{ name: 'submit', args: {} }] }]),
      log: () => undefined,
      client: tools,
    });
    const record = path.join(root, 'reviews', 'r1');
    const lock = JSON.parse(await readFile(path.join(record, 'review.lock.json'), 'utf8'));
    expect(lock).toMatchObject({ design: 'board', sweep: 'sweep-record', fab: ['fab/gerbers', path.join(elsewhere, 'bom.csv')], fabProfile: 'fab/jlc.yaml' });
    expect(JSON.stringify(lock)).not.toContain(root);
    expect(tools.calls.find((c) => c.tool === 'review-bundle')!.inputs).toMatchObject({ drop: path.join(root, 'board'), sweep: path.join(root, 'sweep-record') });
    expect((await replayReview(record, undefined, () => undefined, tools)).identical).toBe(true);
    // The bundle is pinned by the lockfile too.
    await writeFile(path.join(record, 'bundle.json'), '{}');
    await expect(replayReview(record, undefined, () => undefined, tools)).rejects.toThrow(/bundle\.json differs from the lockfile/);
  }, 30_000);

  it('refuses budgets that are not positive numbers before writing anything', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const base = { design: path.join(root, 'd'), out: path.join(root, 'rec'), sources: [], model: 's', domains: ['P'], maxTurns: 5, maxMinutes: 5, parallel: 1, makeProvider: async () => scriptedProvider([]), log: () => undefined, client: fakeTools() };
    await expect(runReview({ ...base, maxTurns: Number('nope') })).rejects.toThrow(/--max-turns must be a positive whole number/);
    await expect(runReview({ ...base, maxTurns: 0 })).rejects.toThrow(/--max-turns/);
    await expect(runReview({ ...base, parallel: 1.5 })).rejects.toThrow(/--parallel/);
    await expect(runReview({ ...base, maxMinutes: -1 })).rejects.toThrow(/--max-minutes/);
    expect(await readdir(root)).toEqual([]);
  });

  it('cancels a run: stops its passes, keeps their samples, and a resume reruns them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    const out = path.join(root, 'record');
    const tools = fakeTools();
    const cancel = new AbortController();
    const hanging = (): Provider => ({
      name: 'hanging',
      async chat(messages: Msg[]): Promise<Turn> {
        if (messages.length < 4) return { text: null, toolCalls: [{ id: 'q', name: 'nets', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
        setTimeout(() => cancel.abort(), 20);
        return new Promise(() => undefined);
      },
    });
    const base = { design, out, sources: [], model: 's', domains: ['P', 'L'], maxTurns: 5, maxMinutes: 5, parallel: 1, log: () => undefined, client: tools };
    await expect(runReview({ ...base, makeProvider: async () => hanging(), signal: cancel.signal })).rejects.toThrow(CancelledError);
    expect(JSON.parse(await readFile(path.join(out, 'model', 'samples', 'P.json'), 'utf8'))).toMatchObject({ outcome: 'failed', error: 'cancelled', turns: 2 });
    expect(await readdir(path.join(out, 'model', 'samples'))).toEqual(['P.json']);
    const submitter = () => scriptedProvider([{ toolCalls: [{ name: 'submit', args: {} }] }]);
    const res = await runReview({ ...base, resume: true, makeProvider: async () => submitter() });
    expect(res.passes.map((p) => [p.domain, p.outcome])).toEqual([['P', 'submitted'], ['L', 'submitted']]);
  }, 30_000);

  it('reruns a pass whose sample a killed run left unreadable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    const out = path.join(root, 'record');
    const base = { design, out, sources: [], model: 's', domains: ['P'], maxTurns: 5, maxMinutes: 5, parallel: 1, log: () => undefined, client: fakeTools() };
    const submitter = () => scriptedProvider([{ toolCalls: [{ name: 'submit', args: {} }] }]);
    await runReview({ ...base, makeProvider: async () => submitter() });
    await writeFile(path.join(out, 'model', 'samples', 'P.json'), '{"domain": "P", "outc');
    let made = 0;
    const res = await runReview({ ...base, resume: true, makeProvider: async () => (made++, submitter()) });
    expect(made).toBe(1);
    expect(res.passes[0]).toMatchObject({ domain: 'P', outcome: 'submitted' });
  }, 30_000);

  it('refuses a record directory inside the design, or one that is not empty', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const base = { sources: [], model: 's', domains: ['P'], maxTurns: 1, maxMinutes: 1, parallel: 1, makeProvider: async () => scriptedProvider([]), log: () => undefined, client: fakeTools() };
    await expect(runReview({ ...base, design: root, out: path.join(root, 'rec') })).rejects.toThrow(/outside the design/);
    const full = path.join(root, 'full');
    await mkdir(full);
    await writeFile(path.join(full, 'x'), '');
    await expect(runReview({ ...base, design: path.join(root, 'd'), out: full })).rejects.toThrow(/not empty/);
  });

  it('refuses a record directory that reaches into the design or an input through a link', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(path.join(design, 'empty'), { recursive: true });
    await mkdir(path.join(root, 'docs'));
    await symlink(path.join(design, 'empty'), path.join(root, 'link'));
    const base = { sources: [path.join(root, 'docs')], model: 's', domains: ['P'], maxTurns: 1, maxMinutes: 1, parallel: 1, makeProvider: async () => scriptedProvider([]), log: () => undefined, client: fakeTools() };
    await expect(runReview({ ...base, design, out: path.join(root, 'link') })).rejects.toThrow(/outside the design/);
    await expect(runReview({ ...base, design, out: path.join(root, 'link', 'new') })).rejects.toThrow(/outside the design/);
    await symlink(design, path.join(root, 'design-link'));
    await expect(runReview({ ...base, design: path.join(root, 'design-link'), out: path.join(design, 'rec') })).rejects.toThrow(/outside the design/);
    await expect(runReview({ ...base, design, out: path.join(root, 'docs', 'rec') })).rejects.toThrow(/outside every input/);
    expect(await readdir(path.join(design, 'empty'))).toEqual([]);
  });
});

describe('review: the copperhead-tools client', () => {
  it('stops the tool process when cancelled', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const pidFile = path.join(dir, 'pid');
    const script = path.join(dir, 'slow-tools.js');
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);\n`);
    const client = await resolveTools(script, {});
    const cancel = new AbortController();
    const running = client.run('review', {}, { signal: cancel.signal });
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    }
    expect(pid).toBeGreaterThan(0);
    cancel.abort();
    await expect(running).rejects.toThrow(/cancelled/);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 30_000);
});
