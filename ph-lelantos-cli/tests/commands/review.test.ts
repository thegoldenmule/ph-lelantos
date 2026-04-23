import { describe, it, expect } from '@jest/globals';

import {
  aggregateFindings,
  parseRecommendations,
  renderCite,
  renderFindings,
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
  it('collapses repeated findings with the same (analyzerId, ruleId, model) into a group', () => {
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
      // New default: 1 example per group.
      expect(items[0].examples).toHaveLength(1);
    }
  });

  it('honours explicit threshold / maxExamples options', () => {
    const findings = Array.from({ length: 5 }, (_, i) =>
      makeFinding({ location: { file: `src/f${i}.ts`, line: i + 1 } }),
    );
    const items = aggregateFindings(findings, { threshold: 3, maxExamples: 3 });
    expect(items).toHaveLength(1);
    if (items[0].kind === 'group') {
      expect(items[0].examples).toHaveLength(3);
    }
  });

  it('keeps below-threshold buckets as singles', () => {
    const findings = [
      makeFinding({ location: { file: 'a.ts', line: 1 } }),
    ];
    const items = aggregateFindings(findings);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('single');
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

describe('renderFindingsPlain — file grouping (default)', () => {
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

  it('prints the file-grouped header', () => {
    const out = renderFindingsPlain(findings).join('\n');
    expect(out).toContain('=== FINDINGS (by file) ===');
  });

  it('puts the file with the most errors first', () => {
    const out = renderFindingsPlain(findings).join('\n');
    const errLineIdx = out.indexOf('src/reducers/lifecycle.ts');
    const warnLineIdx = out.indexOf('src/schema/invoice-0.graphql');
    expect(errLineIdx).toBeGreaterThanOrEqual(0);
    expect(warnLineIdx).toBeGreaterThanOrEqual(0);
    expect(errLineIdx).toBeLessThan(warnLineIdx);
  });

  it('prefixes each finding with a severity glyph', () => {
    const out = renderFindingsPlain(findings).join('\n');
    expect(out).toContain('✖'); // error
    expect(out).toContain('⚠'); // warning
  });

  it('includes the summary block with totals and per-model tallies', () => {
    const out = renderFindingsPlain(findings).join('\n');
    expect(out).toContain('=== SUMMARY ===');
    expect(out).toContain('1 errors');
    expect(out).toContain('5 warnings');
    expect(out).toContain('Invoice');
  });

  it('puts the summary AFTER the findings body', () => {
    const out = renderFindingsPlain(findings).join('\n');
    expect(out.indexOf('=== FINDINGS')).toBeLessThan(out.indexOf('=== SUMMARY ==='));
  });

  it('shows top offenders (files and rules)', () => {
    const out = renderFindingsPlain(findings).join('\n');
    expect(out).toContain('Top files:');
    expect(out).toContain('Top rules:');
  });

  it('ends with a FAIL verdict when any errors exist', () => {
    const lines = renderFindingsPlain(findings);
    const last = lines[lines.length - 1];
    expect(last).toContain('FAIL');
    expect(last).toContain('1 error');
  });

  it('ends with a PASS-with-warnings verdict when only warnings exist', () => {
    const warnOnly = findings.filter((f) => f.severity === 'warning');
    const lines = renderFindingsPlain(warnOnly);
    const last = lines[lines.length - 1];
    expect(last).toContain('PASS with 5 warnings');
  });

  it('returns a green PASS verdict for empty input', () => {
    const lines = renderFindingsPlain([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('PASS');
    expect(lines[0]).toContain('no findings');
  });

  it('hides info-severity findings by default and reports the hidden count', () => {
    const withInfo = [
      ...findings,
      makeFinding({
        severity: 'info',
        ruleId: 'style-nit',
        location: { file: 'src/x.ts', line: 1 },
      }),
    ];
    const out = renderFindingsPlain(withInfo).join('\n');
    expect(out).toContain('hidden below --min-severity=warning');
  });

  it('includes info findings when --min-severity=info', () => {
    const withInfo = [
      ...findings,
      makeFinding({
        severity: 'info',
        ruleId: 'style-nit',
        message: 'trivial style',
        location: { file: 'src/x.ts', line: 1 },
      }),
    ];
    const out = renderFindingsPlain(withInfo, { minSeverity: 'info' }).join('\n');
    expect(out).toContain('trivial style');
    expect(out).not.toContain('hidden below');
  });
});

describe('renderFindingsPlain — by severity', () => {
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

  it('renders severity section headers with counts', () => {
    const out = renderFindingsPlain(findings, { by: 'severity' }).join('\n');
    expect(out).toContain('=== ERROR (1) ===');
    expect(out).toContain('=== WARNING (5) ===');
  });

  it('collapses repeated warnings by default', () => {
    const out = renderFindingsPlain(findings, { by: 'severity' }).join('\n');
    expect(out).toContain('(x5 occurrences)');
  });

  it('expands every finding with evidence under verbose', () => {
    const out = renderFindingsPlain(findings, {
      by: 'severity',
      verbose: true,
    }).join('\n');
    expect(out).not.toContain('(x5 occurrences)');
    expect(out).toContain('no maxLength');
    expect(out).toContain('src/schema/invoice-0.graphql:1');
    expect(out).toContain('src/schema/invoice-4.graphql:5');
  });
});

describe('renderFindings with forced color', () => {
  it('emits ANSI codes when useColor=true, regardless of TTY', () => {
    const findings = [
      makeFinding({
        severity: 'error',
        ruleId: 'no-date-now',
        analyzerId: 'reducer-purity',
        location: { file: 'src/r.ts', line: 1 },
      }),
    ];
    const out = renderFindings(findings, { useColor: true }).join('\n');
    // ANSI escape sequences start with \x1b[.
    expect(out).toMatch(/\x1b\[/);
  });
});
