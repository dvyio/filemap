/** @fileoverview Installs Husky hooks outside npm dry-run commands. */

import installHusky from 'husky';

if (process.env['npm_config_dry_run'] === 'true') {
  process.exit(0);
}

const message = installHusky();

if (message !== '') {
  process.stdout.write(message);
}
