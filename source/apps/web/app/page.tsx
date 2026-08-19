"use client";

import dynamic from "next/dynamic";

// xterm + WebGL cannot render on the server — the whole dashboard is a client island.
const Dashboard = dynamic(() => import("@/components/Dashboard"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center text-faint">
      summoning daimons…
    </div>
  ),
});

export default function Page() {
  return <Dashboard />;
}
