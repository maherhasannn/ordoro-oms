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
  const { first, last } = splitName(addr.name);
  const digits = (addr.phone || "").replace(/\D/g, "");
  const phone = digits.length >= 10
    ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`
    : "";

  return {
    DropShipFirstName: (first || "").slice(0, 20),
    DropShipMiddleInitial: "",
    DropShipLastName: (last || first || "").slice(0, 20),
    DropShipCompany: (addr.company || "").slice(0, 30),
    DropShipAddress1: (addr.street1 || "").slice(0, 30),
    DropShipAddress2: (addr.street2 || "").slice(0, 30),
    DropShipCity: (addr.city || "").slice(0, 20),
    DropShipState: (addr.state || "").slice(0, 2),
    DropShipPostalCode: addr.zip || "",
    DropShipPhone: phone,
    DropShipCountry: addr.country || "US",
    DropShipEmail: (addr.email || "").slice(0, 50),
  };
}

export function mapAddressForMeyer(addr) {
  const country = addr.country || "US";
  const countryMap = { US: "USA", CA: "CAN", MX: "MEX" };
  const phone = (addr.phone || "").replace(/\D/g, "");

  return {
    ShipToName: addr.name || "",
    ShipToAddress1: addr.street1 || "",
    ShipToAddress2: addr.street2 || "",
    ShipToCity: addr.city || "",
    ShipToState: addr.state || "",
    ShipToZipcode: addr.zip || "",
    ShipToCountry: countryMap[country] || country,
    ShipToPhone: phone.length === 10 || phone.length === 14 ? phone : "",
  };
}
