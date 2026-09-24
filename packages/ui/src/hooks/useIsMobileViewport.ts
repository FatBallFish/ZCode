import { useEffect, useState } from "react";

/**
 * 小屏视口判定（spec §21.4.3）：< 768px 视为手机/小屏布局。
 * 供壳层切换「覆盖式侧栏抽屉 + 返回会话列表」导航；桌面壳不启用（保留窗口 resize 自动收起语义）。
 */
export function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 767px)").matches : false,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const listener = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches);
    };
    query.addEventListener("change", listener);
    setIsMobile(query.matches);
    return () => {
      query.removeEventListener("change", listener);
    };
  }, []);
  return isMobile;
}
