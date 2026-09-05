#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright');
const { randomUUID } = require('node:crypto');
const { loadProjectEnvironment } = require('../shared/load-env');

loadProjectEnvironment();

const baseUrl = process.env.BETTER_AUTH_URL || 'http://127.0.0.1:3000';
const adminEmail = process.env.QUANTPILOT_AUTH_ADMIN_EMAIL || 'admin@quantpilot.local';
const adminPassword = process.env.QUANTPILOT_AUTH_ADMIN_PASSWORD || 'admin';
const scope = `authz-e2e-${randomUUID()}`;
const memberEmail = `${scope}@quantpilot.local`;
const projectId = `${scope}-member`;
const foreignProjectId = `${scope}-admin`;
const memberTestPassword = 'MemberVerification!2026';

async function api(page, path, init = {}) {
  return page.evaluate(async ({ path, init }) => {
    const response = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body };
  }, { path, init });
}

async function login(page, identity, password) {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('账号或邮箱').fill(identity);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 15_000 });
}

async function changePassword(page, currentPassword, nextPassword) {
  if (!page.url().includes('/account/security')) {
    await page.goto(`${baseUrl}/account/security`, { waitUntil: 'networkidle' });
  }
  await page.getByLabel('当前密码').fill(currentPassword);
  await page.getByLabel('新密码', { exact: true }).fill(nextPassword);
  await page.getByLabel('确认新密码').fill(nextPassword);
  await page.getByRole('button', { name: '修改密码' }).click();
  await page.waitForURL(`${baseUrl}/`, { timeout: 15_000 });
}

async function main() {
  const prisma = new PrismaClient();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.QUANTPILOT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  let memberId = null;
  let adminPage = null;
  const fixtureProjectIds = new Set();
  try {
    const admin = await prisma.authUser.findUnique({
      where: { email: adminEmail },
      include: { accounts: { where: { providerId: 'credential' }, take: 1 } },
    });
    if (!admin || !admin.accounts[0]?.password) throw new Error('Local admin credential is missing.');
    if (admin.mustChangePassword) throw new Error('Local default admin unexpectedly requires a password change.');
    const adminContext = await browser.newContext();
    adminPage = await adminContext.newPage();
    await login(adminPage, adminEmail, adminPassword);
    await adminPage.goto(`${baseUrl}/admin/users`, { waitUntil: 'networkidle' });
    await adminPage.getByRole('heading', { name: '用户管理' }).waitFor();

    // Always exercise cross-project access, even in a fresh database. Never
    // borrow a real user's project or change their membership for a smoke test.
    fixtureProjectIds.add(foreignProjectId);
    const foreignProjectResult = await api(adminPage, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ projectId: foreignProjectId, name: 'Authorization E2E Admin Project' }),
    });
    if (foreignProjectResult.status !== 201) {
      throw new Error(`Admin fixture creation failed: ${foreignProjectResult.status}`);
    }

    const created = await api(adminPage, '/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ name: 'Authorization E2E Member', email: memberEmail, role: 'member' }),
    });
    if (created.status !== 201 || !created.body?.data?.initialPassword) {
      throw new Error(`Create member failed: ${created.status}`);
    }
    memberId = created.body.data.userId;

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await login(memberPage, memberEmail, created.body.data.initialPassword);
    if (!memberPage.url().includes('/account/security')) {
      throw new Error('New member was not forced to change the initial password.');
    }
    await changePassword(memberPage, created.body.data.initialPassword, memberTestPassword);

    const initialProjects = await api(memberPage, '/api/projects');
    if (initialProjects.status !== 200 || (initialProjects.body?.data?.length ?? -1) !== 0) {
      throw new Error('Member project list was not isolated.');
    }
    fixtureProjectIds.add(projectId);
    const createProject = await api(memberPage, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ projectId, name: 'Authorization E2E Project' }),
    });
    if (createProject.status !== 201) throw new Error(`Member project creation failed: ${createProject.status}`);

    const ownProject = await api(memberPage, `/api/projects/${projectId}`);
    if (ownProject.status !== 200) throw new Error('Project owner could not read their own project.');

    const foreignProject = foreignProjectResult.body.data;
    const forbiddenProject = await api(memberPage, `/api/projects/${encodeURIComponent(foreignProject.id)}`);
    if (forbiddenProject.status !== 404) {
      throw new Error(`Cross-project access was not denied: ${forbiddenProject.status}`);
    }

    const membershipPath = `/api/projects/${encodeURIComponent(foreignProject.id)}/members`;
    const grantViewer = await api(adminPage, membershipPath, {
      method: 'PUT',
      body: JSON.stringify({ email: memberEmail, role: 'viewer' }),
    });
    if (grantViewer.status !== 200) {
      throw new Error(`Grant viewer membership failed: ${grantViewer.status}`);
    }
    const viewerRead = await api(memberPage, `/api/projects/${encodeURIComponent(foreignProject.id)}`);
    if (viewerRead.status !== 200) throw new Error('Viewer could not read an assigned project.');
    const viewerWrite = await api(memberPage, `/api/projects/${encodeURIComponent(foreignProject.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: foreignProject.name }),
    });
    if (viewerWrite.status !== 403) {
      throw new Error(`Viewer write access was not denied: ${viewerWrite.status}`);
    }
    const removeViewer = await api(adminPage, membershipPath, {
      method: 'DELETE',
      body: JSON.stringify({ userId: memberId }),
    });
    if (removeViewer.status !== 200 || removeViewer.body?.data?.removedCount !== 1) {
      throw new Error(`Remove viewer membership failed: ${removeViewer.status}`);
    }
    const afterMembershipRemoval = await api(memberPage, `/api/projects/${encodeURIComponent(foreignProject.id)}`);
    if (afterMembershipRemoval.status !== 404) {
      throw new Error(`Removed viewer retained project access: ${afterMembershipRemoval.status}`);
    }

    const tokenAccess = await api(memberPage, '/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ provider: 'github', token: 'must-not-be-written' }),
    });
    if (tokenAccess.status !== 403) throw new Error(`Platform secret access was not denied: ${tokenAccess.status}`);

    const disabled = await api(adminPage, '/api/admin/users', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'set-status', userId: memberId, banned: true }),
    });
    if (disabled.status !== 200) {
      throw new Error(`Disable member failed: ${disabled.status} ${JSON.stringify(disabled.body)}`);
    }
    const afterDisable = await api(memberPage, '/api/projects');
    if (![401, 403].includes(afterDisable.status)) {
      throw new Error(`Disabled member retained access: ${afterDisable.status}`);
    }

    await memberContext.close();
    console.log('User management E2E: lifecycle, forced password change, membership roles, project isolation and revocation verified');
  } finally {
    let cleanupFailed = false;
    for (const id of fixtureProjectIds) {
      try {
        const result = await api(adminPage, `/api/projects/${id}`, { method: 'DELETE' });
        if (![200, 404].includes(result.status)) throw new Error(`HTTP ${result.status}`);
      } catch (error) {
        cleanupFailed = true;
        console.error(`Fixture ${id} retained for review: ${error.message}`);
      }
    }
    try {
      if (memberId && !cleanupFailed) {
        await prisma.authUser.deleteMany({ where: { id: memberId, email: memberEmail } });
      }
      // Sign out only the browser session this run created. Audit records,
      // concurrent administrator sessions and shared rate limits remain intact.
      if (adminPage && !adminPage.isClosed()) {
        await api(adminPage, '/api/auth/sign-out', { method: 'POST', body: '{}' }).catch(() => undefined);
      }
    } finally {
      await browser.close();
      await prisma.$disconnect();
    }
    if (cleanupFailed) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
