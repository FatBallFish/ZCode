import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SessionProvider, useSession } from "./lib/api.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { AdminLayout } from "./pages/AdminLayout.tsx";
import "./index.css";

function App() {
  const { ready, authenticated } = useSession();
  if (!ready) {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-neutral-500">
        正在检查登录态…
      </div>
    );
  }
  return authenticated ? <AdminLayout /> : <LoginPage />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
