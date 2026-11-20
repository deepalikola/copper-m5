// The refund store on Supabase (tables in supabase/migrations/
// 20261110000000_refunds.sql). `order_id` is the primary key, so Postgres
// itself refuses a second refund for an order, and every status change is a
// conditional update ("only if the status is still X"), so two requests at once
// can't both win.
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Refund,
  RefundPatch,
  RefundStatus,
  RefundStore,
} from "@/lib/copper/refund-store";

const LIMIT_KEY = "refund_limit_cents";
const UNIQUE_VIOLATION = "23505";

type Row = {
  order_id: string;
  item: string;
  amount_cents: number;
  currency: string;
  status: RefundStatus;
  decided_by: Refund["decidedBy"];
  limit_cents: number;
  requested_at: string;
  decided_at: string | null;
};

const fromRow = (row: Row): Refund => ({
  orderId: row.order_id,
  item: row.item,
  amountCents: row.amount_cents,
  currency: row.currency,
  status: row.status,
  decidedBy: row.decided_by,
  limitCents: row.limit_cents,
  requestedAt: row.requested_at,
  decidedAt: row.decided_at,
});

const toRow = (refund: Refund): Row => ({
  order_id: refund.orderId,
  item: refund.item,
  amount_cents: refund.amountCents,
  currency: refund.currency,
  status: refund.status,
  decided_by: refund.decidedBy,
  limit_cents: refund.limitCents,
  requested_at: refund.requestedAt,
  decided_at: refund.decidedAt,
});

const patchRow = (patch: RefundPatch): Partial<Row> => ({
  ...(patch.status !== undefined && { status: patch.status }),
  ...(patch.decidedBy !== undefined && { decided_by: patch.decidedBy }),
  ...(patch.decidedAt !== undefined && { decided_at: patch.decidedAt }),
});

export function createSupabaseRefundStore(db: SupabaseClient): RefundStore {
  async function get(orderId: string) {
    const { data, error } = await db
      .from("refunds")
      .select("*")
      .eq("order_id", orderId)
      .maybeSingle<Row>();
    if (error) throw new Error(`Couldn't read the refund: ${error.message}`);
    return data ? fromRow(data) : null;
  }

  return {
    async getLimitCents() {
      const { data, error } = await db
        .from("app_settings")
        .select("value")
        .eq("key", LIMIT_KEY)
        .maybeSingle<{ value: number }>();
      if (error) throw new Error(`Couldn't read the limit: ${error.message}`);
      if (!data) throw new Error("The refund limit isn't set in app_settings.");
      return data.value;
    },
    async setLimitCents(cents) {
      const { error } = await db
        .from("app_settings")
        .upsert({ key: LIMIT_KEY, value: cents });
      if (error) throw new Error(`Couldn't save the limit: ${error.message}`);
    },
    async list() {
      const { data, error } = await db
        .from("refunds")
        .select("*")
        .order("requested_at")
        .returns<Row[]>();
      if (error) throw new Error(`Couldn't read refunds: ${error.message}`);
      return data.map(fromRow);
    },
    get,
    async create(refund) {
      const { error } = await db.from("refunds").insert(toRow(refund));
      if (!error) return { created: true, refund };
      if (error.code !== UNIQUE_VIOLATION)
        throw new Error(`Couldn't save the refund: ${error.message}`);
      const earlier = await get(refund.orderId);
      if (!earlier) throw new Error("The refund exists but couldn't be read.");
      return { created: false, refund: earlier };
    },
    async transition(orderId, from, patch) {
      const { data, error } = await db
        .from("refunds")
        .update(patchRow(patch))
        .eq("order_id", orderId)
        .in("status", from)
        .select()
        .returns<Row[]>();
      if (error)
        throw new Error(`Couldn't update the refund: ${error.message}`);
      return data[0] ? fromRow(data[0]) : null;
    },
    async remove(orderId, status) {
      const { error } = await db
        .from("refunds")
        .delete()
        .eq("order_id", orderId)
        .eq("status", status);
      if (error) throw new Error(`Couldn't undo the refund: ${error.message}`);
    },
  };
}
