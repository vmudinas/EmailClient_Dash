/**
 * The addresses this deployment may send from.
 *
 * Mirrors SendingIdentity.cs on the API, which is the authority: the server refuses anything
 * outside this list regardless of what the UI offers. This copy exists so the compose dialog can
 * show the right choices without a round trip, not to decide policy. Keep the two in step.
 */

export const AI_FROM_ADDRESS = "ai@vitas.work";
export const DEVELOPMENT_FROM_ADDRESS = "code@vitas.work";

export const SENDING_ADDRESSES = [
  { email: AI_FROM_ADDRESS, label: "Automated and general mail" },
  { email: DEVELOPMENT_FROM_ADDRESS, label: "Recruiters and development" },
  { email: "me@vitas.work", label: "Personal" },
  { email: "gliukaz@gmail.com", label: "Personal (legacy)" }
] as const;

export const SENDING_ADDRESS_VALUES: readonly string[] = SENDING_ADDRESSES.map((entry) => entry.email);

export function isAllowedSendingAddress(address: string | null | undefined): boolean {
  return SENDING_ADDRESS_VALUES.includes((address ?? "").trim().toLowerCase());
}

/**
 * What a new message should start from. Recruiter and development threads default to the
 * development address so a reply about engineering work does not read as automated.
 */
export function defaultSendingAddress(developmentRelated: boolean): string {
  return developmentRelated ? DEVELOPMENT_FROM_ADDRESS : AI_FROM_ADDRESS;
}
