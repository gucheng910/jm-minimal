import { client } from "../core/api";
import { API_PATHS } from "../core/endpoints";
import { sessionStore } from "../core/storage";
import type { LoginResult, MemberInfo, RegisterPayload, RegisterResult } from "../core/types";

export const authService = {
  async login(username: string, password: string, remember = false): Promise<MemberInfo> {
    // noAuth：登录必须不带本地旧 token，否则服务端只回现有会话、不签发新 jwttoken
    const data = await client.request<LoginResult>(API_PATHS.login, { username, password }, { method: "POST", noAuth: true });
    // 兼容官方不同时期的响应位置：顶层 jwttoken 或嵌套 data.jwttoken
    const nested = (data as unknown as { data?: { jwttoken?: string } }).data;
    const token = data.jwttoken || nested?.jwttoken;
    if (!token) {
      throw new Error("登录响应缺少 jwttoken（响应字段：" + Object.keys(data).join("、") + "）");
    }
    sessionStore.saveAuth(token, data as MemberInfo);
    sessionStore.account = remember ? { username, password } : null;
    return data as MemberInfo;
  },

  /**
   * 官方注册（对官方 2.1.6 前端 register 表单逐字段照抄）：
   *   - 入参只有 username / email / password / password_confirm / gender（性别取值 "Male" | "Female"）；
   *   - 两个勾选框（我已满18岁 / 同意条款）是官方前端本地拦截，不参与请求体；
   *   - 成功与否看响应里的 status（"ok"）与 msg，官方直接把 msg 当提示文案用。
   */
  async register(p: RegisterPayload): Promise<RegisterResult> {
    return client.request<RegisterResult>(
      API_PATHS.register,
      { username: p.username, email: p.email, password: p.password, password_confirm: p.password_confirm, gender: p.gender },
      { method: "POST", noAuth: true, noRelogin: true }
    );
  },

  async logout(): Promise<void> {
    try {
      await client.request(API_PATHS.logout, {}, { method: "POST", retries: 1 });
    } finally {
      sessionStore.clearAuth();
    }
  },

  async reloginFromStoredAccount(): Promise<MemberInfo | null> {
    const account = sessionStore.account;
    if (!account) return null;
    return this.login(account.username, account.password, true);
  }
};
