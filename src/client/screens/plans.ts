/** Plans & Pricing: the table from the specification, read from the server's plan file. Buying needs a payment provider; without one it says so. */
import type { App, Screen } from "../app.js";
import { api, errorText } from "../net.js";
import { buildShell } from "../shell.js";
import { clear, h, openDialog } from "../kit.js";
import type { PlanInfo, PlansData } from "../types.js";
import { notice, statusBadge, fill } from "../widgets.js";

interface PlansReply extends PlansData { current: string; billing: { configured: boolean; reason: string } }

const ROWS: Array<[string, (p: PlanInfo) => string]> = [
  ["Local documents", (p) => (p.local_documents === "unlimited" ? "Unlimited" : p.local_documents)],
  ["Cloud storage", (p) => `${p.cloud_gb} GB${p.per_seat ? " per paid seat, pooled" : ""}`],
  ["Local AI", (p) => p.local_ai],
  ["Hosted AI / month", (p) => `${p.hosted_credits} credits${p.per_seat ? " per paid user, pooled" : ""}`],
  ["Collaboration", (p) => p.collaboration],
  ["EMBED", (p) => p.embed],
  ["Workspace", (p) => p.workspace],
  ["Support", (p) => p.support],
];

export async function plansScreen(app: App): Promise<Screen> {
  const shell = buildShell(app, "plans");
  const data = await api.get<PlansReply>("/plans");
  let yearly = false;
  const host = h("div", { class: "table-wrap" });
  const money = (n: number): string => (n === 0 ? "FREE" : `${data.currency === "EUR" ? "€" : `${data.currency} `}${Number.isInteger(n) ? n : n.toFixed(2)}`);

  const checkout = async (plan: PlanInfo): Promise<void> => {
    try {
      const out = await api.post<{ message?: string }>("/plans/checkout", { plan: plan.id });
      openDialog({ title: plan.name, noCancel: true, body: h("p", { text: out.message ?? "Done." }), actions: [{ label: "Close", kind: "primary", run: () => true }] });
    } catch (e) {
      openDialog({ title: `${plan.name} cannot be bought here`, noCancel: true, size: "narrow",
        body: h("div", {}, notice(errorText(e), "warn"), h("p", { text: "Nothing was charged and your plan is unchanged." })), actions: [{ label: "Close", kind: "primary", run: () => true }] });
    }
  };

  const paint = (): void => {
    clear(host);
    const head = h("tr", {}, h("th", { scope: "col" }, h("span", { class: "visually-hidden", text: "Feature" })), ...data.plans.map((p) => h("th", { scope: "col", class: p.recommended ? "recommended" : "" }, p.name, p.recommended ? h("div", { class: "badge", text: "Recommended" }) : null)));
    const price = h("tr", {}, h("th", { scope: "row", text: yearly ? "Per year" : "Per month" }), ...data.plans.map((p) => h("td", {}, h("strong", { text: money(yearly ? p.yearly : p.monthly) }), p.per_seat && p.monthly ? h("div", { class: "muted", text: "per paid user" }) : null)));
    const action = h("tr", {}, h("th", { scope: "row", text: "Plan" }), ...data.plans.map((p) => {
      if (p.current) return h("td", {}, statusBadge("Current plan", "ok"));
      if (p.monthly === 0) return h("td", {}, h("span", { class: "muted", text: "Free" }));
      const b = h("button", { class: "btn", type: "button", text: "Buy now" });
      b.addEventListener("click", () => { void checkout(p); });
      return h("td", {}, b);
    }));
    const body = ROWS.map(([label, get]) => h("tr", {}, h("th", { scope: "row", text: label }), ...data.plans.map((p) => h("td", { text: get(p) }))));
    host.appendChild(h("table", { class: "plans" }, h("thead", {}, head), h("tbody", {}, price, action, ...body)));
  };

  const toggle = h("div", { class: "seg", attrs: { role: "group", "aria-label": "Billing period" } },
    h("button", { class: "btn small", type: "button", text: "Monthly", attrs: { "aria-pressed": "true" } }),
    h("button", { class: "btn small", type: "button", text: `Yearly · save up to ${data.yearlyDiscountPercent}%`, attrs: { "aria-pressed": "false" } }));
  const [mBtn, yBtn] = [...toggle.querySelectorAll("button")] as [HTMLButtonElement, HTMLButtonElement];
  mBtn.addEventListener("click", () => { yearly = false; mBtn.setAttribute("aria-pressed", "true"); yBtn.setAttribute("aria-pressed", "false"); paint(); });
  yBtn.addEventListener("click", () => { yearly = true; yBtn.setAttribute("aria-pressed", "true"); mBtn.setAttribute("aria-pressed", "false"); paint(); });

  fill(shell.main,
    h("h2", { class: "page-title", text: "Plans & Pricing" }),
    toggle,
    h("p", { class: "muted", text: `${data.studentDiscountPercent}% discount for verified students (provisional; no combined offer is promised). Creator is the recommended individual plan.` }),
    data.billing.configured ? null : notice(data.billing.reason, "warn", "Buying is not connected."),
    host,
    h("div", { class: "fine" },
      h("p", { text: `Workspace is ${money(data.plans.find((p) => p.id === "workspace")?.monthly ?? 30)} per paid user per month. Prices are launch hypotheses; ${data.vatNote}` }),
      h("p", { text: "Guests have no hosted storage or credits; there is no local document-count cap beyond technical limits. Local AI needs a compatible model and device. Storage, AI credits, live-editor limits and support targets are provisional. Credits meter inference cost, not component prompts. Collaboration is a later stage; advanced publishing and security is a later stage." }),
      h("p", { text: "Baseline security is universal: account protection, basic encryption and signature verification." })));
  paint();
  return { el: shell.el, destroy: shell.dispose };
}
