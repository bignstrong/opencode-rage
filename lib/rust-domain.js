import { rustBinding } from "./rust-binding.js";

// undefined means reference mode. A Rust operation can legitimately return JSON null.
export function rustDomain(domain, op, args) {
  const binding = rustBinding();
  return binding ? JSON.parse(binding[domain](op, JSON.stringify(args))) : undefined;
}
