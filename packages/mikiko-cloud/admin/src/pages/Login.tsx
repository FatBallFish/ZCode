import { useState, type FormEvent } from "react";
import { useSession } from "../lib/api.tsx";

/** 登录页：产品 logo + 账密 + 错误提示（方案 D.3，替代旧版两个裸 input）。 */
export function LoginPage() {
  const { signIn } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(username, password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-dvh items-center justify-center bg-neutral-950">
      <form
        onSubmit={submit}
        className="w-[22rem] space-y-5 rounded-2xl border border-neutral-800 bg-neutral-900 p-8 shadow-xl"
      >
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 text-2xl font-black text-neutral-950">
            M
          </div>
          <h1 className="text-lg font-semibold text-neutral-100">Mikiko 云管理后台</h1>
          <p className="text-xs text-neutral-500">仅限管理员访问</p>
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-neutral-400">用户名</span>
          <input
            className="w-full rounded-lg border border-neutral-700 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-amber-500"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-neutral-400">密码</span>
          <input
            type="password"
            className="w-full rounded-lg border border-neutral-700 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-amber-500"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !username || !password}
          className="w-full rounded-lg bg-amber-500 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-amber-400 disabled:opacity-40"
        >
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
