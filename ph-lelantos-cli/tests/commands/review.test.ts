import { describe, it, expect } from '@jest/globals';

import {
  parseRecommendations,
  renderCite,
} from '../../src/commands/review.js';

describe('parseRecommendations', () => {
  it('parses the prompt-defined list format into cites + text', () => {
    const md = [
      '- Cites: reducer-purity:no-date-now@src/reducers/order.ts:7',
      '  Move createdAt to the action input so the reducer stays deterministic.',
      '- Cites: taint-tracking:untrusted-string-to-url@src/editors/login.ts:12, schema-alignment:missing-required-field-guard@src/schema/session.ts:3',
      '  Validate redirectUrl against an allowlist and require the field in the input schema.',
    ].join('\n');

    const recs = parseRecommendations(md);
    expect(recs).toHaveLength(2);
    expect(recs[0].cites).toEqual([
      'reducer-purity:no-date-now@src/reducers/order.ts:7',
    ]);
    expect(recs[0].text).toContain('Move createdAt');
    expect(recs[1].cites).toEqual([
      'taint-tracking:untrusted-string-to-url@src/editors/login.ts:12',
      'schema-alignment:missing-required-field-guard@src/schema/session.ts:3',
    ]);
    expect(recs[1].text).toContain('allowlist');
  });

  it('falls back to a single uncited recommendation when no list items parse', () => {
    const md = 'Nothing worth flagging in the finding set.';
    const recs = parseRecommendations(md);
    expect(recs).toEqual([{ cites: [], text: md }]);
  });

  it('returns [] for empty input', () => {
    expect(parseRecommendations('')).toEqual([]);
    expect(parseRecommendations('   \n  \n')).toEqual([]);
  });
});

describe('renderCite', () => {
  it('transforms analyzerId:ruleId@file:line into the bracketed grep form', () => {
    expect(renderCite('reducer-purity:no-date-now@src/reducers/order.ts:7')).toBe(
      '[reducer-purity/no-date-now @ src/reducers/order.ts:7]',
    );
  });

  it('passes through malformed cite strings in brackets', () => {
    expect(renderCite('not a cite')).toBe('[not a cite]');
  });
});
