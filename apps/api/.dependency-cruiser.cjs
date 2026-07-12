/**
 * Module-boundary enforcement (PRD v5 §2.3). CRM must consume other modules
 * ONLY through their public facades — never their internal services or
 * repositories — and nothing outside CRM may reach into CRM internals. The
 * platform modules (audit, notifications) and core/* are shared by design.
 *
 * Run: pnpm -F api lint:boundaries   (part of the sprint gate)
 */
module.exports = {
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.spec\\.ts$' },
  },
  forbidden: [
    {
      name: 'crm-imports-only-facades',
      severity: 'error',
      comment:
        'CRM may import other feature modules only via their public facade ' +
        '(modules/<name>/public.ts). Shared platform modules (audit, ' +
        'notifications, webhooks, public-api) and core/* are exempt.',
      from: { path: '^src/modules/crm/' },
      to: {
        path: '^src/modules/(?!crm/)',
        pathNot: [
          '^src/modules/(audit|notifications|webhooks|public-api)/',
          '/public\\.ts$',
          '\\.module\\.ts$',
        ],
      },
    },
    {
      name: 'no-reaching-into-crm',
      severity: 'error',
      comment:
        'Other modules may not import CRM internals — only its public facade.',
      from: { path: '^src/modules/(?!crm/)' },
      to: {
        path: '^src/modules/crm/',
        pathNot: ['^src/modules/crm/public\\.ts$', '\\.module\\.ts$'],
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies between files are always a bug brewing.',
      from: {},
      to: { circular: true },
    },
  ],
};
