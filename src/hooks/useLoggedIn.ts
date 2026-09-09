// 登录态：全局唯一判据（sessionStore.isLoggedIn）+ 订阅变化，避免各页面各判一套
import { useEffect, useState } from "react";
import { on } from "../core/bus";
import { sessionStore } from "../core/storage";

export function useLoggedIn(): boolean {
  const [logged, setLogged] = useState(() => sessionStore.isLoggedIn());
  useEffect(() => on("jm:authChanged", () => setLogged(sessionStore.isLoggedIn())), []);
  return logged;
}
