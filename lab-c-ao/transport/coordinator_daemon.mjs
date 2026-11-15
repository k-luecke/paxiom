/**
 * Standalone Coordinator Daemon for Networked Distributed WASM Runner (C95-AO-00B).
 *
 * Implements coordinator state machine matching coordinator.lua over HTTP router.
 * Tracks distinct accounting counters, lease tokens, and stale rejection.
 */

const ROUTER_URL = process.env.ROUTER_URL || 'http://127.0.0.1:8765';
const PROCESS_ID = process.env.PROCESS_ID || 'coord-net-01';

const runs = new Map();
let running = true;

async function postSend(target, action, data, retries = 5) {
  const payload = {
    from: PROCESS_ID,
    target,
    action,
    data,
  };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${ROUTER_URL}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connection': 'keep-alive' },
        body: JSON.stringify(payload),
      });
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
}

function requeueExpired(run, now) {
  let count = 0;
  for (const s of run.shards) {
    if (s.status === 'leased' && s.lease_expires_ms && now >= s.lease_expires_ms) {
      s.status = 'ready';
      s.worker = null;
      s.lease_expires_ms = null;
      s.lease_token = null;
      s.attempts = (s.attempts || 1);
      run.expired_leases = (run.expired_leases || 0) + 1;
      count++;
    }
  }
  return count;
}

function summarize(run) {
  let done = 0;
  let leased = 0;
  let ready = 0;
  let tested = 0;
  let attempts = 0;

  for (const s of run.shards) {
    attempts += (s.attempts || 0);
    if (s.status === 'done') {
      done++;
      tested += (s.end_index - s.start_index);
    } else if (s.status === 'leased') {
      leased++;
    } else {
      ready++;
    }
  }

  return {
    run_id: run.run_id,
    target_id: run.target_id,
    family_digest: run.family_digest,
    kernel_digest: run.kernel_digest,
    candidate_count: run.candidate_count,
    shard_count: run.shards.length,
    done,
    leased,
    ready,
    tested,
    complete: done === run.shards.length,
    hit_count: run.hits.length,
    hits: run.hits,
    lease_attempts: attempts,
    expired_leases: run.expired_leases || 0,
    mathematical_candidates: run.candidate_count,
    unique_accepted_evaluations: tested,
    physical_evaluations: run.physical_evaluations || 0,
    accepted_completions: done,
    rejected_stale_or_duplicate: run.rejected_stale_or_duplicate || 0,
    gateways_used: Array.from(new Set(run.shards.map((s) => s.gateway).filter(Boolean))),
    shard_details: run.shards.map((s) => ({
      shard_id: s.shard_id,
      start_index: s.start_index,
      end_index: s.end_index,
      status: s.status,
      completed_by: s.completed_by || null,
      gateway: s.gateway || null,
      gateway_status: s.gateway_status || null,
    })),
  };
}

function handleMessage(msg) {
  const { from, action, data, timestamp } = msg;
  const now = timestamp || Date.now();

  if (action === 'CreateRun') {
    const { run_id, target_id, candidate_count, shard_size, lease_ms, family_digest, kernel_digest } = data;
    if (!run_id || runs.has(run_id)) {
      return postSend(from, 'LabCError', { error: 'invalid or duplicate run_id' });
    }
    const n = Number(candidate_count);
    const z = Number(shard_size);
    const ttl = Number(lease_ms) || 120000;

    const shards = [];
    let i = 0;
    let sid = 0;
    while (i < n) {
      const e = Math.min(i + z, n);
      sid++;
      shards.push({
        shard_id: sid,
        start_index: i,
        end_index: e,
        status: 'ready',
        attempts: 0,
        worker: null,
        lease_expires_ms: null,
        lease_token: null,
      });
      i = e;
    }

    const run = {
      run_id,
      target_id: target_id || 'test-target',
      candidate_count: n,
      shard_size: z,
      lease_ms: ttl,
      family_digest,
      kernel_digest,
      shards,
      hits: [],
      physical_evaluations: 0,
      rejected_stale_or_duplicate: 0,
      expired_leases: 0,
    };
    runs.set(run_id, run);
    return postSend(from, 'RunCreated', summarize(run));
  } else if (action === 'LeaseShard') {
    const run = runs.get(data.run_id);
    if (!run) return postSend(from, 'LabCError', { error: 'unknown run' });
    requeueExpired(run, now);

    const s = run.shards.find((x) => x.status === 'ready');
    if (!s) {
      return postSend(from, 'NoShard', summarize(run));
    }

    s.status = 'leased';
    s.worker = from;
    s.attempts = (s.attempts || 0) + 1;
    s.lease_expires_ms = now + run.lease_ms;
    s.lease_token = `${run.run_id}:${s.shard_id}:${s.attempts}:${s.lease_expires_ms}`;
    run.physical_evaluations += (s.end_index - s.start_index);

    return postSend(from, 'ShardLease', {
      run_id: run.run_id,
      target_id: run.target_id,
      family_digest: run.family_digest,
      kernel_digest: run.kernel_digest,
      shard_id: s.shard_id,
      start_index: s.start_index,
      end_index: s.end_index,
      lease_token: s.lease_token,
      lease_expires_ms: s.lease_expires_ms,
    });
  } else if (action === 'SubmitShard') {
    const run = runs.get(data.run_id);
    if (!run) return postSend(from, 'LabCError', { error: 'unknown run' });
    requeueExpired(run, now);

    const sid = Number(data.shard_id);
    const s = run.shards[sid - 1];
    if (!s) return postSend(from, 'LabCError', { error: 'unknown shard' });

    if (s.status !== 'leased') {
      run.rejected_stale_or_duplicate++;
      return postSend(from, 'LabCError', { error: 'shard not leased' });
    }
    if (s.worker !== from) {
      run.rejected_stale_or_duplicate++;
      return postSend(from, 'LabCError', { error: 'lease owner mismatch' });
    }
    if (data.lease_token !== s.lease_token) {
      run.rejected_stale_or_duplicate++;
      return postSend(from, 'LabCError', { error: 'stale lease token' });
    }
    if (data.family_digest !== run.family_digest || data.kernel_digest !== run.kernel_digest) {
      return postSend(from, 'LabCError', { error: 'digest mismatch' });
    }
    const expected = s.end_index - s.start_index;
    if (Number(data.tested) !== expected) {
      return postSend(from, 'LabCError', { error: 'tested count mismatch' });
    }
    for (const f of ['secret', 'private_key', 'seed', 'mnemonic']) {
      if (data[f]) return postSend(from, 'LabCError', { error: 'plaintext secret rejected' });
    }

    s.status = 'done';
    s.result_digest = data.result_digest;
    s.completed_by = from;
    s.gateway = data.gateway || null;
    s.gateway_status = data.gateway_status || null;
    s.worker = null;
    s.lease_expires_ms = null;
    s.lease_token = null;

    if (data.hit_commitment) {
      run.hits.push({
        shard_id: s.shard_id,
        hit_commitment: data.hit_commitment,
        result_digest: data.result_digest,
      });
    }

    return postSend(from, 'ShardAccepted', summarize(run));
  } else if (action === 'GetRun') {
    const run = runs.get(data.run_id);
    if (!run) return postSend(from, 'LabCError', { error: 'unknown run' });
    requeueExpired(run, now);
    return postSend(from, 'RunState', summarize(run));
  } else if (action === 'RequeueExpired') {
    const run = runs.get(data.run_id);
    if (!run) return postSend(from, 'LabCError', { error: 'unknown run' });
    const count = requeueExpired(run, now);
    return postSend(from, 'ExpiredRequeued', { count, state: summarize(run) });
  } else if (action === 'Shutdown') {
    running = false;
    return postSend(from, 'ShutdownAck', { ok: true });
  }
}

async function loop() {
  while (running) {
    try {
      // Periodically expire leases across all runs
      const now = Date.now();
      for (const run of runs.values()) {
        requeueExpired(run, now);
      }

      const res = await fetch(`${ROUTER_URL}/poll/${PROCESS_ID}`);
      const body = await res.json();
      if (body.ok && body.message) {
        await handleMessage(body.message);
      }
    } catch (err) {
      // router reconnect wait
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

loop();
