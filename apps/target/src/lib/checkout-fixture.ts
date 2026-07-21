export const SYNTHETIC_CART = Object.freeze({
  id: "cart-bandung-001",
  items: Object.freeze([
    Object.freeze({
      id: "batik-pesisir-001",
      name: "Kemeja Batik Pesisir",
      variant: "Nila · Ukuran M",
      quantity: 1,
      unitPrice: 489_000,
    }),
    Object.freeze({
      id: "tas-kanvas-001",
      name: "Tas Kanvas Lipat",
      variant: "Gading",
      quantity: 1,
      unitPrice: 129_000,
    }),
  ]),
  subtotal: 618_000,
  shipping: 19_000,
  total: 637_000,
  currency: "IDR",
} as const);

export const SYNTHETIC_SHOPPER = Object.freeze({
  fullName: "Naufal",
  phoneDisplay: "+62 812-3456-7890",
  phoneE164: "+6281234567890",
  addressLine1: "Jl. Asia Afrika No. 8",
  district: "Sumur Bandung",
  cityRegency: "Kota Bandung",
  province: "Jawa Barat",
  postalCode: "40111",
  country: "ID",
  timeZone: "Asia/Jakarta",
} as const);

export const formatIdr = (amount: number): string =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);

export const formatJakartaDateTime = (instant: string): string =>
  new Intl.DateTimeFormat("id-ID", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: SYNTHETIC_SHOPPER.timeZone,
  }).format(new Date(instant));
