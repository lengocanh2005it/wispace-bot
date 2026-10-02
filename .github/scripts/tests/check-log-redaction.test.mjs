import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  hasUnsafeExternalIdInterpolation,
  statements,
} = require('../check-log-redaction.js');

function firstStatement(line) {
  return [...statements([line])][0]?.statement;
}

test('an unrelated errorMessage helper does not mask a raw PSID', () => {
  const statement = firstStatement(
    'logger.warn(`Failed for psid=${psid}: ${errorMessage(error)}`);',
  );

  assert.equal(hasUnsafeExternalIdInterpolation(statement), true);
});

test('each id interpolation can use its own id-specific mask helper', () => {
  const statement = firstStatement(
    'logger.warn(`psid=${maskExternalId(psid)} event=${maskEventId(eventId, psid)} text=${maskExternalIdInText(externalUserId)} detail=${errorMessage(error)}`);',
  );

  assert.equal(hasUnsafeExternalIdInterpolation(statement), false);
});

test('a raw interpolation is not excused by another masked interpolation', () => {
  const statement = firstStatement(
    'logger.warn(`masked=${maskExternalId(psid)} raw=${externalUserId}`);',
  );

  assert.equal(hasUnsafeExternalIdInterpolation(statement), true);
});

test('redactLogLine around the complete logger argument remains accepted', () => {
  const statement = firstStatement(
    'logger.warn(redactLogLine(`psid=${psid}`));',
  );

  assert.equal(hasUnsafeExternalIdInterpolation(statement), false);
});
