#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const REVISION_PATTERN = /^[0-9a-f]{7,64}$/i;
const FIXTURE_PATTERN = /^packages\/llm-agent\/fixtures\/[^/]+\.json$/;
const DECISION_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const REVIEW_STATES = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'DISMISSED',
  'COMMENTED',
  'PENDING',
]);

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

function normalizePath(file) {
  return file.replaceAll('\\', '/');
}

function isProtectedPath(file) {
  const normalized = normalizePath(file);
  return (
    normalized.startsWith('packages/llm-agent/src/') ||
    normalized === 'packages/llm-agent/package.json' ||
    normalized === 'package.json' ||
    normalized.startsWith('packages/chat-agent/src/agent/') ||
    /^apps\/[^/]+\/src\/shared\/prompts\/[^/]+-chat\.system\.txt$/.test(normalized) ||
    normalized.startsWith('apps/messenger-bot/src/modules/messenger/application/agent/') ||
    normalized === '.github/workflows/guardrail-battery.yml' ||
    normalized === '.github/workflows/eval-rehash-policy.yml' ||
    /^\.github\/scripts\/check-eval-rehash-pr\.(?:js|sh)$/.test(normalized)
  );
}

function changedFiles(root, baseSha, headSha) {
  const output = git(root, [
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    baseSha + '...' + headSha,
  ]);
  const fields = output.split('\0');
  const files = [];
  for (let index = 0; index < fields.length - 1; ) {
    const status = fields[index++];
    const file = fields[index++];
    if (!status || !file) {
      throw new Error('git diff returned incomplete name-status metadata');
    }
    files.push({ status: status[0], file: normalizePath(file) });
  }
  return files;
}

function readRevisionFile(root, revision, file) {
  try {
    return execFileSync('git', ['show', '--no-textconv', revision + ':' + file], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function parseFixtureHashes(raw, label) {
  let fixture;
  try {
    fixture = JSON.parse(raw);
  } catch {
    throw new Error(label + ' is not valid JSON');
  }
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new Error(label + ' must contain a JSON object');
  }
  if (typeof fixture.coreHash !== 'string' || !HASH_PATTERN.test(fixture.coreHash)) {
    throw new Error(label + ' has an invalid coreHash');
  }
  if (!Array.isArray(fixture.promptFiles)) {
    throw new Error(label + ' has invalid promptFiles metadata');
  }
  const promptFiles = fixture.promptFiles.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(label + ' promptFiles[' + index + '] is invalid');
    }
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new Error(label + ' promptFiles[' + index + '] has no path');
    }
    if (typeof entry.hash !== 'string' || !HASH_PATTERN.test(entry.hash)) {
      throw new Error(label + ' promptFiles[' + index + '] has an invalid hash');
    }
    return { path: entry.path, hash: entry.hash.toLowerCase() };
  });
  return {
    coreHash: fixture.coreHash.toLowerCase(),
    promptFiles,
  };
}

function fixtureHashChanged(root, baseSha, headSha, entry) {
  if (!FIXTURE_PATTERN.test(entry.file)) {
    return false;
  }
  if (entry.status === 'D') {
    const oldRaw = readRevisionFile(root, baseSha, entry.file);
    if (oldRaw === null) {
      throw new Error('deleted fixture ' + entry.file + ' is missing from the base revision');
    }
    parseFixtureHashes(oldRaw, baseSha + ':' + entry.file);
    return true;
  }
  if (entry.status === 'A') {
    const newRaw = readRevisionFile(root, headSha, entry.file);
    if (newRaw === null) {
      throw new Error('added fixture ' + entry.file + ' is missing from the head revision');
    }
    parseFixtureHashes(newRaw, headSha + ':' + entry.file);
    return true;
  }
  const oldRaw = readRevisionFile(root, baseSha, entry.file);
  const newRaw = readRevisionFile(root, headSha, entry.file);
  if (oldRaw === null || newRaw === null) {
    throw new Error('modified fixture ' + entry.file + ' is missing from one revision');
  }
  const oldHashes = parseFixtureHashes(oldRaw, baseSha + ':' + entry.file);
  const newHashes = parseFixtureHashes(newRaw, headSha + ':' + entry.file);
  return (
    oldHashes.coreHash !== newHashes.coreHash ||
    JSON.stringify(oldHashes.promptFiles) !== JSON.stringify(newHashes.promptFiles)
  );
}

function readMetadataFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error('unable to read pull request metadata');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('pull request metadata is not valid JSON');
  }
}

function validatePullRequest(metadata, baseSha, headSha, prNumber) {
  if (!metadata || typeof metadata !== 'object' || !metadata.pullRequest) {
    throw new Error('pull request metadata is incomplete');
  }
  const pullRequest = metadata.pullRequest;
  if (
    prNumber &&
    String(pullRequest.number) !== String(prNumber)
  ) {
    throw new Error('pull request metadata number does not match the event');
  }
  if (
    !pullRequest.base ||
    pullRequest.base.sha !== baseSha ||
    !pullRequest.head ||
    pullRequest.head.sha !== headSha
  ) {
    throw new Error('pull request metadata does not match the checked out revisions');
  }
  if (!pullRequest.user || typeof pullRequest.user.login !== 'string') {
    throw new Error('pull request author metadata is missing');
  }
  if (!Array.isArray(pullRequest.labels)) {
    throw new Error('pull request labels metadata is missing');
  }
  const labels = pullRequest.labels.map((label) => {
    if (!label || typeof label.name !== 'string') {
      throw new Error('pull request label metadata is malformed');
    }
    return label.name;
  });
  if (!Array.isArray(metadata.reviews)) {
    throw new Error('pull request review metadata is missing');
  }
  return {
    author: pullRequest.user.login.toLowerCase(),
    hasApprovalLabel: labels.includes('eval-rehash-approved'),
    reviews: metadata.reviews,
  };
}

function latestReviewDecisions(reviews) {
  const latest = new Map();
  reviews.forEach((review, index) => {
    if (!review || typeof review !== 'object') {
      throw new Error('pull request review metadata is malformed');
    }
    const state = typeof review.state === 'string' ? review.state.toUpperCase() : '';
    if (!REVIEW_STATES.has(state)) {
      throw new Error('pull request review has an unknown state');
    }
    if (!DECISION_STATES.has(state)) {
      return;
    }
    if (!review.user || typeof review.user.login !== 'string') {
      throw new Error('pull request review author metadata is missing');
    }
    if (typeof review.submitted_at !== 'string' || Number.isNaN(Date.parse(review.submitted_at))) {
      throw new Error('pull request review timestamp is malformed');
    }
    if (typeof review.commit_id !== 'string' || review.commit_id.length === 0) {
      throw new Error('pull request review commit metadata is missing');
    }
    const reviewer = review.user.login.toLowerCase();
    const candidate = {
      state,
      reviewer,
      association:
        typeof review.author_association === 'string'
          ? review.author_association.toUpperCase()
          : '',
      commitId: review.commit_id,
      submittedAt: Date.parse(review.submitted_at),
      index,
    };
    const previous = latest.get(reviewer);
    if (
      !previous ||
      candidate.submittedAt > previous.submittedAt ||
      (candidate.submittedAt === previous.submittedAt && candidate.index > previous.index)
    ) {
      latest.set(reviewer, candidate);
    }
  });
  return [...latest.values()];
}

function approvalFailureReason(prMetadata, headSha) {
  if (!prMetadata.hasApprovalLabel) {
    return 'missing eval-rehash-approved label';
  }
  const decisions = latestReviewDecisions(prMetadata.reviews);
  if (decisions.some((decision) => decision.commitId === headSha && (decision.state === 'CHANGES_REQUESTED' || decision.state === 'DISMISSED'))) {
    return 'a current-head review requests changes or is dismissed';
  }
  const approved = decisions.find(
    (decision) =>
      decision.state === 'APPROVED' &&
      decision.commitId === headSha &&
      decision.reviewer !== prMetadata.author &&
      (decision.association === 'OWNER' || decision.association === 'MEMBER'),
  );
  return approved ? null : 'no fresh trusted approval for the current head';
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error('GitHub API request failed with status ' + response.status);
  }
  return response.json();
}

async function fetchMetadata() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const prNumber = process.env.EVAL_REHASH_PR_NUMBER;
  if (
    !repository ||
    !token ||
    !prNumber ||
    !/^\d+$/.test(prNumber) ||
    !/^[^/]+\/[^/]+$/.test(repository)
  ) {
    throw new Error('GitHub pull request metadata is unavailable');
  }
  const baseUrl = 'https://api.github.com/repos/' + repository + '/pulls/' + prNumber;
  const pullRequest = await fetchJson(baseUrl, token);
  const reviews = [];
  for (let page = 1; page <= 100; page += 1) {
    const pageReviews = await fetchJson(baseUrl + '/reviews?per_page=100&page=' + page, token);
    if (!Array.isArray(pageReviews)) {
      throw new Error('GitHub review metadata is malformed');
    }
    reviews.push(...pageReviews);
    if (pageReviews.length < 100) {
      break;
    }
    if (page === 100) {
      throw new Error('GitHub review metadata exceeds the supported limit');
    }
  }
  return { pullRequest, reviews };
}

async function main() {
  const root = path.resolve(process.argv[2] || path.resolve(__dirname, '..', '..'));
  const baseSha = process.env.EVAL_REHASH_BASE_SHA;
  const headSha = process.env.EVAL_REHASH_HEAD_SHA;
  if (!baseSha || !headSha) {
    throw new Error('EVAL_REHASH_BASE_SHA and EVAL_REHASH_HEAD_SHA are required');
  }
  if (!REVISION_PATTERN.test(baseSha) || !REVISION_PATTERN.test(headSha)) {
    throw new Error('base and head revisions must be hexadecimal commit ids');
  }
  git(root, ['rev-parse', '--verify', baseSha + '^{commit}']);
  git(root, ['rev-parse', '--verify', headSha + '^{commit}']);
  const files = changedFiles(root, baseSha, headSha);
  const protectedFiles = files.filter((entry) => isProtectedPath(entry.file));
  const hashFiles = files.filter((entry) => fixtureHashChanged(root, baseSha, headSha, entry));

  if (protectedFiles.length === 0 || hashFiles.length === 0) {
    console.log('EVAL REHASH POLICY: PASS');
    return;
  }

  const changeSummary =
    '; protected files: ' +
    protectedFiles.map((entry) => entry.file).join(', ') +
    '; hash changes: ' +
    hashFiles.map((entry) => entry.file).join(', ');
  let prMetadata;
  try {
    const metadata = process.env.EVAL_REHASH_METADATA_FILE
      ? readMetadataFile(process.env.EVAL_REHASH_METADATA_FILE)
      : await fetchMetadata();
    prMetadata = validatePullRequest(
      metadata,
      baseSha,
      headSha,
      process.env.EVAL_REHASH_PR_NUMBER,
    );
  } catch (error) {
    throw new Error(
      (error instanceof Error ? error.message : 'pull request metadata failed') +
        changeSummary,
    );
  }
  const reason = approvalFailureReason(prMetadata, headSha);
  if (reason) {
    throw new Error(reason + changeSummary);
  }
  console.log('EVAL REHASH POLICY: PASS');
}

main().catch((error) => {
  console.error('EVAL REHASH POLICY: FAIL');
  console.error(error instanceof Error ? error.message : 'unknown policy failure');
  process.exitCode = 1;
});
