import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { clientRoutes, findClientDir } from './client-static';

const BUILD = path.join('client', 'dist', 'client', 'browser');

describe('client-static', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-client-static-'));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function writeBuild(): string {
    const dir = path.join(repo, BUILD);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<app-root></app-root>');
    fs.writeFileSync(path.join(dir, 'main.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'main-XWFOQL5H.js'), 'console.log(2)');
    fs.mkdirSync(path.join(dir, 'media'));
    fs.writeFileSync(path.join(dir, 'media', 'icons-HKY7TYOV.woff2'), 'font');
    return dir;
  }

  describe('findClientDir', () => {
    it('finds the build from the compiled server (dist/server)', () => {
      const dir = writeBuild();
      expect(findClientDir(path.join(repo, 'dist', 'server'))).toBe(dir);
    });

    it('finds the build from the source server under ts-node (server/)', () => {
      const dir = writeBuild();
      expect(findClientDir(path.join(repo, 'server'))).toBe(dir);
    });

    it('returns null when the client has not been built', () => {
      expect(findClientDir(path.join(repo, 'server'))).toBeNull();
    });

    it('ignores a build folder without index.html', () => {
      fs.mkdirSync(path.join(repo, BUILD), { recursive: true });
      expect(findClientDir(path.join(repo, 'server'))).toBeNull();
    });
  });

  describe('clientRoutes', () => {
    it('serves static files and falls back to index.html for app routes', async () => {
      const app = express().use(clientRoutes(writeBuild()));

      const asset = await request(app).get('/main.js');
      expect(asset.status).toBe(200);
      expect(asset.text).toBe('console.log(1)');

      const route = await request(app).get('/chapters/abc/edit');
      expect(route.status).toBe(200);
      expect(route.text).toContain('<app-root>');
    });

    it('caches content-hashed assets forever', async () => {
      const app = express().use(clientRoutes(writeBuild()));

      for (const url of ['/main-XWFOQL5H.js', '/media/icons-HKY7TYOV.woff2']) {
        const res = await request(app).get(url);
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      }
    });

    it('never caches index.html or unhashed files without revalidating', async () => {
      const app = express().use(clientRoutes(writeBuild()));

      for (const url of ['/', '/index.html', '/chapters/abc/edit']) {
        const res = await request(app).get(url);
        expect(res.headers['cache-control']).toBe('no-cache');
      }
      const unhashed = await request(app).get('/main.js');
      expect(unhashed.headers['cache-control']).not.toContain('immutable');
    });

    it('explains how to get the app when the client has not been built', async () => {
      const res = await request(express().use(clientRoutes(null))).get('/series');
      expect(res.status).toBe(503);
      expect(res.type).toBe('text/plain');
      expect(res.text).toContain('http://localhost:6258');
      expect(res.text).toContain('npm run build');
    });
  });
});
