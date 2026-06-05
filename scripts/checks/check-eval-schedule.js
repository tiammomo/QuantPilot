#!/usr/bin/env node

require('tsconfig-paths/register');

const path = require('path');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/checks/check-eval-schedule.js'), {
  interopDefault: true,
});

const { checkQuantEvalSchedule } = jiti('../../src/lib/eval/index.ts');

checkQuantEvalSchedule()
  .then((result) => {
    if (result.queued) {
      console.log(`[eval-schedule] queued ${result.item.id}, next=${result.schedule.nextRunAt}`);
    } else {
      console.log(`[eval-schedule] idle, enabled=${result.schedule.enabled}, next=${result.schedule.nextRunAt || '-'}`);
    }
  })
  .catch((error) => {
    console.error('[eval-schedule] failed:', error);
    process.exitCode = 1;
  });
