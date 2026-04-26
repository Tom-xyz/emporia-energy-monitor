/**
 * AWS Cognito authentication for the Emporia cloud API.
 * Tokens are cached on disk and auto-refreshed before expiry.
 */

import { promises as fs } from 'fs';

const COGNITO_URL    = 'https://cognito-idp.us-east-2.amazonaws.com/';
const COGNITO_CLIENT = '4qte47jbstod8apnfic0bunmrq';
const REFRESH_SLACK  = 5 * 60 * 1000;

export class EmporiaAuth {
  constructor({ username, password, keysFile }) {
    if (!username || !password) throw new Error('Emporia: EMPORIA_EMAIL and EMPORIA_PASSWORD are required');
    if (!keysFile)              throw new Error('Emporia: keysFile path required');
    this.username  = username;
    this.password  = password;
    this.keysFile  = keysFile;
    this.tokens    = null;
    this.refreshing = null;
  }

  async _cognito(flow, params) {
    const res = await fetch(COGNITO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({ AuthFlow: flow, ClientId: COGNITO_CLIENT, AuthParameters: params }),
    });
    if (!res.ok) throw new Error(`Cognito ${flow}: ${res.status} ${await res.text()}`);
    return (await res.json()).AuthenticationResult;
  }

  async _loadCache() {
    try { this.tokens = JSON.parse(await fs.readFile(this.keysFile, 'utf8')); }
    catch { this.tokens = null; }
  }

  async _saveCache() {
    if (!this.tokens) return;
    await fs.writeFile(this.keysFile, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
  }

  async _login() {
    const ar = await this._cognito('USER_PASSWORD_AUTH', { USERNAME: this.username, PASSWORD: this.password });
    this.tokens = {
      access_token:  ar.AccessToken,
      id_token:      ar.IdToken,
      refresh_token: ar.RefreshToken,
      expires_at:    Date.now() + ar.ExpiresIn * 1000,
      username:      this.username,
    };
    await this._saveCache();
  }

  async _refresh() {
    if (this.refreshing) { await this.refreshing; return; }
    this.refreshing = (async () => {
      try {
        const ar = await this._cognito('REFRESH_TOKEN_AUTH', { REFRESH_TOKEN: this.tokens.refresh_token });
        this.tokens.access_token = ar.AccessToken;
        this.tokens.id_token     = ar.IdToken;
        this.tokens.expires_at   = Date.now() + ar.ExpiresIn * 1000;
        await this._saveCache();
      } catch {
        // Refresh token likely expired or revoked — fall back to fresh login
        await this._login();
      }
    })();
    try { await this.refreshing; } finally { this.refreshing = null; }
  }

  /** Get a valid id_token, refreshing or re-authenticating as needed. */
  async getIdToken() {
    if (!this.tokens) await this._loadCache();
    if (!this.tokens?.id_token) { await this._login(); return this.tokens.id_token; }

    const expired = !this.tokens.expires_at || Date.now() >= this.tokens.expires_at - REFRESH_SLACK;
    if (expired) await this._refresh();
    return this.tokens.id_token;
  }
}
