import type { Metadata } from "next";
import { SettingsPanel } from "@/components/panels/settings-panel";

export const metadata: Metadata = {
  title: "模型与密钥 | 史稿",
};

export default function ModelsPage() {
  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      <SettingsPanel />
    </div>
  );
}
