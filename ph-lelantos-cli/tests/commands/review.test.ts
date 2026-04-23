import { describe, it, expect } from '@jest/globals';

import {
  aggregateFindings,
  parseRecommendations,
  renderCite,
  renderFindingsPlain,
  shortenPath,
} from '../../src/commands/review.js';
import type { Finding } from '../../src/analysis/types.js';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: 'unbounded-string',
    analyzerId: 'schema-introspection',
    severity: 'warning',
    message: 'String field without maxLength',
    model: 'Invoice',
    ...overrides,
  };
}

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

describe('shortenPath', () => {
  it('strips the .ph-lelantos/cache/<hash>/ prefix', () => {
    const p =
      '/tmp/proj/.ph-lelantos/cache/abcdef1234/document-models/invoice/src/reducers/ops.ts';
    expect(shortenPath(p)).toBe(
      'document-models/invoice/src/reducers/ops.ts',
    );
  });

  it('strips the projectRoot prefix for local targets', () => {
    expect(
      shortenPath('/home/me/proj/src/reducers/ops.ts', '/home/me/proj'),
    ).toBe('src/reducers/ops.ts');
  });

  it('passes bare relative paths through unchanged', () => {
    expect(shortenPath('src/reducers/ops.ts')).toBe('src/reducers/ops.ts');
  });
});

describe('aggregateFindings', () => {
  it('collapses ≥3 findings with the same (analyzerId, ruleId, model) into a group', () => {
    const findings = Array.from({ length: 5 }, (_, i) =>
      makeFinding({
        location: { file: `src/f${i}.ts`, line: i + 1 },
      }),
    );
    const items = aggregateFindings(findings);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'group',
      count: 5,
      analyzerId: 'schema-introspection',
      ruleId: 'unbounded-string',
      model: 'Invoice',
    });
    if (items[0].kind === 'group') {
      expect(items[0].examples).toHaveLength(3);
    }
  });

  it('keeps below-threshold buckets as singles', () => {
    const findings = [
      makeFinding({ location: { file: 'a.ts', line: 1 } }),
      makeFinding({ location: { file: 'b.ts', line: 2 } }),
    ];
    const items = aggregateFindings(findings);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === 'single')).toBe(true);
  });

  it('separates buckets across distinct models', () => {
    const findings = [
      ...Array.from({ length: 3 }, () => makeFinding({ model: 'Invoice' })),
      ...Array.from({ length: 3 }, () => makeFinding({ model: 'Order' })),
    ];
    const items = aggregateFindings(findings);
    expect(items).toHaveLength(2);
    expect(items.map((i) => (i.kind === 'group' ? i.model : null))).toEqual([
      'Invoice',
      'Order',
    ]);
  });
});

describe('renderFindingsPlain', () => {
  const findings: Finding[] = [
    ...Array.from({ length: 5 }, (_, i) =>
      makeFinding({
        severity: 'warning',
        evidence: 'field: description (no maxLength)',
        location: { file: `src/schema/invoice-${i}.graphql`, line: i + 1 },
      }),
    ),
    makeFinding({
      severity: 'error',
      ruleId: 'no-date-now',
      analyzerId: 'reducer-purity',
      message: 'Reducer calls Date.now()',
      model: 'Invoice',
      module: 'lifecycle',
      operation: 'create',
      evidence: 'const now = Date.now();',
      location: { file: 'src/reducers/lifecycle.ts', line: 7 },
    }),
  ];

  it('prints a summary header with global and per-model tallies', () => {
    const out = renderFindingsPlain(findings).join('\n');
    expect(out).toContain('=== SUMMARY ===');
    expect(out).toContain('Total: 1 errors, 5 warnings, 0 info');
    expect(out).toContain('Invoice: 1 errors, 5 warnings, 0 info');
  });

  it('renders severity section headers with counts', () => {
    const out = renderFindingsPlain(findings).join('\n');
    expect(out).toContain('=== ERROR (1) ===');
    expect(out).toContain('=== WARNING (5) ===');
  });

  it('collapses repeated warnings by default with no evidence', () => {
    const out = renderFindingsPlain(findings).join('\n');
    expect(out).toContain('(x5 occurrences)');
    expect(out).not.toContain('no maxLength');
  });

  it('expands every finding with evidence under verbose', () => {
    const out = renderFindingsPlain(findings, { verbose: true }).join('\n');
    expect(out).not.toContain('(x5 occurrences)');
    expect(out).toContain('no maxLength');
    expect(out).toContain('src/schema/invoice-0.graphql:1');
    expect(out).toContain('src/schema/invoice-4.graphql:5');
  });

  it('returns "No findings." when empty', () => {
    expect(renderFindingsPlain([])).toEqual(['No findings.']);
  });
});
