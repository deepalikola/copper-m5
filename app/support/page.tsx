import type { Metadata } from "next";
import { RefundConsole } from "@/components/copper/refund-console";
import { SiteHeader } from "@/components/copper/site-header";
import { SetupRequired } from "@/components/setup-required";
import { isAiConfigured } from "@/lib/ai/call";
import { isRefundStorageReady, refundStorage } from "@/lib/copper/refund-store";

export const metadata: Metadata = { title: "Support | Copper State Labs" };

export default function Support() {
  return (
    // Leaves room on the right for the docked chat.
    <div className="flex flex-1 flex-col lg:pr-[28rem]">
      <SiteHeader />
      {/* Module 4: the Refund Console, with Ask Copper docked on the right.
          Refunds must be kept somewhere shared and lasting in production. */}
      {isRefundStorageReady() ? (
        <RefundConsole
          aiConfigured={isAiConfigured()}
          storage={refundStorage()}
        />
      ) : (
        <SetupRequired service="supabase" />
      )}
    </div>
  );
}
