"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import {
  type CheckoutFieldErrors,
  type CheckoutFieldName,
  type CheckoutValues,
  GENERIC_ORDER_ERROR,
  loadEagerCheckoutRecommendations,
  mapOrderApiError,
  type RecommendationsLoad,
  validateCheckoutValues,
} from "./checkout-behavior";
import {
  formatIdr,
  formatJakartaDateTime,
  SYNTHETIC_CART,
  SYNTHETIC_SHOPPER,
} from "@/lib/checkout-fixture";

type SubmitState = "idle" | "submitting" | "error" | "confirmed";
type OrderConfirmation = { orderId: string; total: number; createdAt: string };

function checkoutValues(form: HTMLFormElement): CheckoutValues {
  const data = new FormData(form);
  const value = (name: CheckoutFieldName) => String(data.get(name) ?? "");
  return {
    fullName: value("fullName"),
    phone: value("phone"),
    addressLine1: value("addressLine1"),
    district: value("district"),
    cityRegency: value("cityRegency"),
    province: value("province"),
    postalCode: value("postalCode"),
  };
}

export function CheckoutForm() {
  const [errors, setErrors] = useState<CheckoutFieldErrors>({});
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [submitMessage, setSubmitMessage] = useState("");
  const [confirmation, setConfirmation] = useState<OrderConfirmation | null>(null);
  const [recommendationStatus, setRecommendationStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const confirmationRef = useRef<HTMLElement>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const recommendationRequestRef = useRef<Promise<RecommendationsLoad> | null>(null);

  useEffect(() => {
    let active = true;
    recommendationRequestRef.current ??= loadEagerCheckoutRecommendations();
    recommendationRequestRef.current.then(
      () => { if (active) setRecommendationStatus("ready"); },
      () => { if (active) setRecommendationStatus("unavailable"); },
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (Object.keys(errors).length > 0) errorSummaryRef.current?.focus();
  }, [errors]);

  useEffect(() => {
    if (confirmation) confirmationRef.current?.focus();
  }, [confirmation]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateCheckoutValues(checkoutValues(event.currentTarget));
    setErrors(nextErrors);
    setSubmitMessage("");
    if (Object.keys(nextErrors).length > 0) {
      setSubmitState("idle");
      return;
    }

    setSubmitState("submitting");
    idempotencyKeyRef.current ??= `rvp:${crypto.randomUUID()}`;

    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKeyRef.current,
        },
        body: JSON.stringify({ cartId: SYNTHETIC_CART.id }),
      });
      const payload = await response.json() as {
        error?: unknown;
        order?: OrderConfirmation;
      };
      if (!response.ok) {
        setSubmitMessage(mapOrderApiError(payload.error));
        setSubmitState("error");
        return;
      }
      if (!payload.order) throw new Error("Invalid order response");

      setConfirmation(payload.order);
      setSubmitState("confirmed");
    } catch {
      setSubmitMessage(GENERIC_ORDER_ERROR);
      setSubmitState("error");
    }
  }

  if (confirmation) {
    return (
      <main className="checkout-shell confirmation-shell">
        <section className="confirmation-card" ref={confirmationRef} tabIndex={-1} aria-labelledby="confirmation-title">
          <div className="confirmation-mark" aria-hidden="true">✓</div>
          <p className="kicker">Pesanan simulasi diterima</p>
          <h1 id="confirmation-title">Terima kasih, pesananmu tercatat.</h1>
          <p className="confirmation-copy">
            Ini hanya konfirmasi sintetis untuk pengujian Roveproof. Tidak ada pembayaran yang diproses.
          </p>
          <dl className="confirmation-details">
            <div><dt>Nomor pesanan</dt><dd>{confirmation.orderId}</dd></div>
            <div><dt>Total</dt><dd>{formatIdr(confirmation.total)}</dd></div>
            <div><dt>Waktu Jakarta</dt><dd>{formatJakartaDateTime(confirmation.createdAt)} WIB</dd></div>
          </dl>
          <a className="secondary-action" href="/checkout">Kembali ke checkout</a>
        </section>
      </main>
    );
  }

  const errorEntries = Object.entries(errors) as Array<[CheckoutFieldName, NonNullable<CheckoutFieldErrors[CheckoutFieldName]>]>;

  return (
    <main className="checkout-shell">
      <header className="shop-header">
        <a className="wordmark" href="/checkout" aria-label="Rantau Goods, checkout">
          <span aria-hidden="true" className="wordmark-mark">RG</span>
          <span>Rantau Goods</span>
        </a>
        <span className="secure-note"><span aria-hidden="true">◇</span> Checkout sintetis</span>
      </header>

      <div className="checkout-grid">
        <section className="checkout-main" aria-labelledby="checkout-title">
          <div className="title-block">
            <p className="kicker">Langkah terakhir</p>
            <h1 id="checkout-title">Ke mana pesanan ini dikirim?</h1>
            <p>Periksa detail penerima dan alamat pengiriman sebelum membuat pesanan simulasi.</p>
          </div>

          {errorEntries.length > 0 ? (
            <div className="error-summary" ref={errorSummaryRef} tabIndex={-1} role="alert" aria-labelledby="error-title">
              <p id="error-title">Ada {errorEntries.length} hal yang perlu diperbaiki</p>
              <ul>
                {errorEntries.map(([field, error]) => <li key={field}><a href={`#${field}`}>{error.message}</a></li>)}
              </ul>
            </div>
          ) : null}

          <form id="checkout-form" noValidate onSubmit={handleSubmit}>
            <section className="form-section" aria-labelledby="recipient-title">
              <div className="section-heading">
                <span className="route-node" aria-hidden="true">1</span>
                <div><h2 id="recipient-title">Penerima</h2><p>Gunakan nama yang tertera pada identitas.</p></div>
              </div>
              <div className="field-grid">
                <Field
                  id="fullName"
                  label="Nama lengkap"
                  defaultValue={SYNTHETIC_SHOPPER.fullName}
                  autoComplete="name"
                  error={errors.fullName}
                />
                <Field
                  id="phone"
                  label="Nomor ponsel"
                  defaultValue={SYNTHETIC_SHOPPER.phoneDisplay}
                  autoComplete="tel"
                  inputMode="tel"
                  hint="Contoh: +62 812-3456-7890"
                  error={errors.phone}
                />
              </div>
            </section>

            <section className="form-section route-section" aria-labelledby="address-title">
              <div className="section-heading">
                <span className="route-node" aria-hidden="true">2</span>
                <div><h2 id="address-title">Alamat Indonesia</h2><p>Pesanan dikirim dari gudang sintetis Bandung.</p></div>
              </div>
              <div className="field-grid">
                <Field id="addressLine1" label="Alamat lengkap" defaultValue={SYNTHETIC_SHOPPER.addressLine1} autoComplete="street-address" error={errors.addressLine1} wide />
                <Field id="district" label="Kecamatan" defaultValue={SYNTHETIC_SHOPPER.district} autoComplete="address-level3" error={errors.district} />
                <Field id="cityRegency" label="Kota / Kabupaten" defaultValue={SYNTHETIC_SHOPPER.cityRegency} autoComplete="address-level2" error={errors.cityRegency} />
                <Field id="province" label="Provinsi" defaultValue={SYNTHETIC_SHOPPER.province} autoComplete="address-level1" error={errors.province} />
                <Field id="postalCode" label="Kode pos" defaultValue={SYNTHETIC_SHOPPER.postalCode} autoComplete="postal-code" inputMode="numeric" error={errors.postalCode} />
              </div>
            </section>

            <section className="form-section route-section" aria-labelledby="payment-title">
              <div className="section-heading">
                <span className="route-node" aria-hidden="true">3</span>
                <div><h2 id="payment-title">Metode simulasi</h2><p>Tidak ada pembayaran atau data kartu.</p></div>
              </div>
              <label className="payment-option">
                <input type="radio" name="payment" value="synthetic-cod" defaultChecked />
                <span className="payment-radio" aria-hidden="true" />
                <span><strong>Bayar di tempat — simulasi</strong><small>Hanya membuat catatan pesanan sintetis</small></span>
                <span className="payment-badge">UJI</span>
              </label>
            </section>

            {submitState === "error" ? <p className="submit-error" role="alert">{submitMessage}</p> : null}
          </form>
        </section>

        <aside className="order-panel" aria-labelledby="summary-title">
          <div className="summary-topline"><h2 id="summary-title">Ringkasan pesanan</h2><span>2 barang</span></div>
          <ul className="cart-list">
            {SYNTHETIC_CART.items.map((item, index) => (
              <li key={item.id}>
                <span className={`product-art product-art-${index + 1}`} aria-hidden="true"><i /><b /></span>
                <span className="product-copy"><strong>{item.name}</strong><small>{item.variant} · {item.quantity}×</small></span>
                <span className="item-price">{formatIdr(item.unitPrice)}</span>
              </li>
            ))}
          </ul>
          <div className="totals">
            <div><span>Subtotal</span><span>{formatIdr(SYNTHETIC_CART.subtotal)}</span></div>
            <div><span>Pengiriman reguler</span><span>{formatIdr(SYNTHETIC_CART.shipping)}</span></div>
            <div className="grand-total"><span>Total</span><strong>{formatIdr(SYNTHETIC_CART.total)}</strong></div>
          </div>
          <p className={`recommendation-status ${recommendationStatus}`} aria-live="polite">
            <span className="status-dot" aria-hidden="true" />
            {recommendationStatus === "loading" ? "Menyiapkan inspirasi produk…" : recommendationStatus === "ready" ? "Inspirasi produk siap" : "Inspirasi produk belum tersedia"}
          </p>
          <button className="primary-action" type="submit" form="checkout-form" disabled={submitState === "submitting"}>
            {submitState === "submitting" ? <><span className="spinner" aria-hidden="true" /> Membuat pesanan…</> : <>Buat pesanan simulasi <span aria-hidden="true">→</span></>}
          </button>
          <p className="fine-print">Dengan melanjutkan, kamu membuat data uji lokal. Tidak ada transaksi finansial.</p>
        </aside>
      </div>
    </main>
  );
}

function Field({
  id,
  label,
  defaultValue,
  error,
  hint,
  wide = false,
  ...inputProps
}: {
  id: CheckoutFieldName;
  label: string;
  defaultValue: string;
  error?: { message: string; seedId?: string };
  hint?: string;
  wide?: boolean;
} & Pick<React.InputHTMLAttributes<HTMLInputElement>, "autoComplete" | "inputMode">) {
  const descriptionIds = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field ${wide ? "field-wide" : ""}`}>
      <label htmlFor={id}>{label}</label>
      <input
        {...inputProps}
        id={id}
        name={id}
        type="text"
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={descriptionIds}
      />
      {hint && !error ? <span className="field-hint" id={`${id}-hint`}>{hint}</span> : null}
      {error ? <span className="field-error" id={`${id}-error`}><span>{error.message}</span>{error.seedId ? <code>{error.seedId}</code> : null}</span> : null}
    </div>
  );
}
