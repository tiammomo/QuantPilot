#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright');

const baseUrl = process.env.BETTER_AUTH_URL || 'http://127.0.0.1:3000';
const memberEmail = 'authz-e2e-member@quantpilot.local';
const projectId = 'authz-e2e-project';
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
  const startedAt = new Date();
  const prisma = new PrismaClient();
  const browser = await chromium.launch({ headless: true });
  let originalAdmin = null;
  let memberId = null;
  try {
    const admin = await prisma.authUser.findUnique({
      where: { email: 'admin@quantpilot.local' },
      include: { accounts: { where: { providerId: 'credential' }, take: 1 } },
    });
    if (!admin || !admin.accounts[0]?.password) throw new Error('Local admin credential is missing.');
    if (admin.mustChangePassword) throw new Error('Local default admin unexpectedly requires a password change.');
    originalAdmin = {
      id: admin.id,
      password: admin.accounts[0].password,
      mustChangePassword: admin.mustChangePassword,
      passwordChangedAt: admin.passwordChangedAt,
    };

    await prisma.authUser.deleteMany({ where: { email: memberEmail } });
    const staleProject = await prisma.project.findUnique({ where: { id: projectId } });
    if (staleProject) await prisma.project.delete({ where: { id: projectId } });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await login(adminPage, 'admin', 'admin');
    await adminPage.goto(`${baseUrl}/admin/users`, { waitUntil: 'networkidle' });
    await adminPage.getByRole('heading', { name: '用户管理' }).waitFor();

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
    const createProject = await api(memberPage, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, name: 'Authorization E2E Project' }),
    });
    if (createProject.status !== 201) throw new Error(`Member project creation failed: ${createProject.status}`);

    const ownProject = await api(memberPage, `/api/projects/${projectId}`);
    if (ownProject.status !== 200) throw new Error('Project owner could not read their own project.');

    const adminProjects = await api(adminPage, '/api/projects');
    const foreignProject = adminProjects.body?.data?.find((project) => project.id !== projectId);
    if (foreignProject) {
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

    await api(adminPage, `/api/projects/${projectId}`, { method: 'DELETE' });
    await memberContext.close();
    await adminContext.close();
    console.log('User management E2E: lifecycle, forced password change, membership roles, project isolation and revocation verified');
  } finally {
    await prisma.authAuditEvent.deleteMany({ where: { createdAt: { gte: startedAt } } }).catch(() => undefined);
    if (memberId) {
      await prisma.authAuditEvent.deleteMany({
        where: { OR: [{ actorUserId: memberId }, { targetId: memberId }, { targetId: projectId }] },
      }).catch(() => undefined);
    }
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => undefined);
    await prisma.authUser.deleteMany({ where: { email: memberEmail } }).catch(() => undefined);
    if (originalAdmin) {
      await prisma.$transaction([
        prisma.authAccount.update({
          where: { providerId_accountId: { providerId: 'credential', accountId: originalAdmin.id } },
          data: { password: originalAdmin.password },
        }),
        prisma.authUser.update({
          where: { id: originalAdmin.id },
          data: {
            mustChangePassword: originalAdmin.mustChangePassword,
            passwordChangedAt: originalAdmin.passwordChangedAt,
          },
        }),
        prisma.authSession.deleteMany({ where: { userId: originalAdmin.id } }),
      ]).catch(() => undefined);
    }
    await prisma.authRateLimit.deleteMany().catch(() => undefined);
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
