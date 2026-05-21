function splitName(fullName) {
  if (!fullName) return { first: "", last: "" };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export function mapAddressForTurn14(addr) {
  const { first, last } = splitName(addr.name);
  return {
    recipient_first_name: first,
    recipient_last_name: last,
    recipient_company: addr.company || "",
    recipient_address1: addr.street1 || "",
    recipient_address2: addr.street2 || "",
    recipient_city: addr.city || "",
    recipient_state: addr.state || "",
    recipient_zip: addr.zip || "",
    recipient_country: addr.country || "US",
    recipient_phone: addr.phone || "",
  };
}

export function mapAddressForEkeystone(addr) {
  return {
    ShipToName: addr.name || "",
    ShipToAddress1: addr.street1 || "",
    ShipToAddress2: addr.street2 || "",
    ShipToCity: addr.city || "",
    ShipToState: addr.state || "",
    ShipToZip: addr.zip || "",
    ShipToCountry: addr.country || "US",
    ShipToPhone: addr.phone || "",
  };
}

export function mapAddressForMeyer(addr) {
  return {
    ShipToName: addr.name || "",
    ShipToAddress1: addr.street1 || "",
    ShipToAddress2: addr.street2 || "",
    ShipToCity: addr.city || "",
    ShipToState: addr.state || "",
    ShipToZip: addr.zip || "",
    ShipToCountry: addr.country || "US",
    ShipToPhone: addr.phone || "",
  };
}
