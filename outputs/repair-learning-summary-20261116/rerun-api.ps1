$ErrorActionPreference = 'Stop'
$env:TS_NODE_PROJECT = 'tsconfig.json'
$tests = @(
'src/modules/repairs/repair-learning-routing.test.ts',
'src/modules/repairs/repair-learning-address-boundary.test.ts',
'src/modules/ai/extract-samples.persistence.test.ts',
'src/modules/notifications/notification-delivery.test.ts',
'src/modules/repairs/repair-address-dedupe.test.ts',
'src/modules/repairs/repair-address-glued.test.ts',
'src/modules/repairs/repair-address-named-room.test.ts',
'src/modules/repairs/repair-address-spot.test.ts',
'src/modules/repairs/repair-address.util.test.ts',
'src/modules/repairs/repair-classify.util.test.ts',
'src/modules/repairs/repair-description-entry.test.ts',
'src/modules/repairs/repair-location-suggestions.test.ts',
'src/modules/repairs/repair-owner-phone-sync.test.ts',
'src/modules/repairs/repair-public-area.util.test.ts',
'src/modules/repairs/repair-suggestions.util.test.ts',
'src/modules/repairs/dispatch-sort.test.ts',
'src/modules/repairs/pool-visibility.test.ts',
'src/modules/repairs/work-order-state-machine.test.ts',
'src/modules/repairs/work-order-rollback.test.ts',
'src/modules/ai/ai-feedback.service.test.ts',
'src/modules/ai/repair-text.ai.test.ts',
'src/modules/ai/repair-speech-merge.test.ts',
'src/modules/staff/staff-assignment.util.test.ts'
)
# Run from apps/api. Isolated fixture SQL/API/notification stubs, never production.
node -r ts-node/register/transpile-only --test @tests
exit $LASTEXITCODE
