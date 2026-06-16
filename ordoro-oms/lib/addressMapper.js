function stripDiacritics(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function splitName(fullName) {
  if (!fullName) return { first: "", last: "" };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export function mapAddressForTurn14(addr) {
  return {
    name: stripDiacritics(addr.name || ""),
    address: addr.street1 || "",
    address_2: addr.street2 || "",
    city: stripDiacritics(addr.city || ""),
    state: addr.state || "",
    zip: addr.zip || "",
    country: addr.country || "US",
    phone_number: (addr.phone || "").replace(/\D/g, ""),
    is_shop_address: false,
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

const COUNTRY_TO_ALPHA3 = {
  US: "USA", CA: "CAN", MX: "MEX", GB: "GBR", AU: "AUS", DE: "DEU",
  FR: "FRA", IT: "ITA", ES: "ESP", JP: "JPN", CN: "CHN", BR: "BRA",
  IN: "IND", KR: "KOR", NL: "NLD", SE: "SWE", NO: "NOR", DK: "DNK",
  FI: "FIN", PL: "POL", AT: "AUT", BE: "BEL", CH: "CHE", IE: "IRL",
  NZ: "NZL", PR: "PRI", VI: "VIR", GU: "GUM",
};

const COUNTRY_NAME_TO_ALPHA3 = {
  "united states": "USA", "usa": "USA", "us": "USA",
  "canada": "CAN", "mexico": "MEX", "united kingdom": "GBR",
  "australia": "AUS", "germany": "DEU", "france": "FRA",
  "italy": "ITA", "spain": "ESP", "japan": "JPN",
  "puerto rico": "PRI",
};

const NUMERIC_TO_ALPHA3 = {
  "840": "USA", "124": "CAN", "484": "MEX", "826": "GBR",
  "036": "AUS", "276": "DEU", "250": "FRA", "380": "ITA",
  "724": "ESP", "392": "JPN", "156": "CHN", "076": "BRA",
  "630": "PRI",
};

function resolveCountryAlpha3(raw) {
  if (!raw) return "USA";
  const trimmed = raw.trim();
  if (trimmed.length === 3 && /^[A-Z]{3}$/i.test(trimmed)) return trimmed.toUpperCase();
  const upper = trimmed.toUpperCase();
  if (COUNTRY_TO_ALPHA3[upper]) return COUNTRY_TO_ALPHA3[upper];
  if (NUMERIC_TO_ALPHA3[trimmed]) return NUMERIC_TO_ALPHA3[trimmed];
  const lower = trimmed.toLowerCase();
  if (COUNTRY_NAME_TO_ALPHA3[lower]) return COUNTRY_NAME_TO_ALPHA3[lower];
  return "USA";
}

export function mapAddressForMeyer(addr) {
  const rawCountry = addr.country_code || addr.country;
  const digits = (addr.phone || "").replace(/\D/g, "");
  const phone = (digits.length === 10 || digits.length === 14) ? digits : digits.slice(0, 10);

  return {
    ShipToName: addr.name || "",
    ShipToAddress1: addr.street1 || "",
    ShipToAddress2: addr.street2 || "",
    ShipToCity: addr.city || "",
    ShipToState: addr.state || "",
    ShipToZipcode: addr.zip || "",
    ShipToCountry: resolveCountryAlpha3(rawCountry),
    ShipToPhone: phone || "",
  };
}
