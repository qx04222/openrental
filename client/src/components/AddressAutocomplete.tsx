/**
 * Google Places Autocomplete Component
 * Restricted to Canadian addresses with structured address extraction
 */

import { useEffect, useRef, useState, useCallback } from "react";

export interface AddressComponents {
  addressLine1: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  lat?: number;
  lng?: number;
  formattedAddress: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onPlaceSelected?: (address: AddressComponents) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Google Maps types unavailable without @types/google.maps
    google: any;
    __googleMapsLoaded?: boolean;
    __googleMapsCallbacks?: (() => void)[];
  }
}

function loadGoogleMapsScript(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.__googleMapsLoaded && window.google?.maps?.places) {
      resolve();
      return;
    }

    if (window.__googleMapsCallbacks) {
      window.__googleMapsCallbacks.push(() => resolve());
      return;
    }

    window.__googleMapsCallbacks = [() => resolve()];

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      window.__googleMapsLoaded = true;
      window.__googleMapsCallbacks?.forEach((cb) => cb());
      window.__googleMapsCallbacks = undefined;
    };
    script.onerror = () => reject(new Error("Failed to load Google Maps"));
    document.head.appendChild(script);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Google Maps PlaceResult type unavailable without @types/google.maps
function extractAddressComponents(place: any): AddressComponents {
  const components = place.address_components || [];
  let streetNumber = "";
  let route = "";
  let city = "";
  let province = "";
  let postalCode = "";
  let country = "";

  for (const comp of components) {
    const types: string[] = comp.types || [];
    if (types.includes("street_number")) streetNumber = comp.long_name;
    else if (types.includes("route")) route = comp.long_name;
    else if (types.includes("locality")) city = comp.long_name;
    else if (types.includes("sublocality_level_1") && !city) city = comp.long_name;
    else if (types.includes("administrative_area_level_1")) province = comp.short_name;
    else if (types.includes("postal_code")) postalCode = comp.long_name;
    else if (types.includes("country")) country = comp.short_name;
  }

  const addressLine1 = streetNumber ? `${streetNumber} ${route}` : route;
  const lat = place.geometry?.location?.lat();
  const lng = place.geometry?.location?.lng();

  return {
    addressLine1,
    city,
    province,
    postalCode,
    country: country || "CA",
    lat,
    lng,
    formattedAddress: place.formatted_address || addressLine1,
  };
}

export default function AddressAutocomplete({
  value,
  onChange,
  onPlaceSelected,
  placeholder = "Start typing an address...",
  required = false,
  className = "",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Google Maps Autocomplete type unavailable
  const autocompleteRef = useRef<any>(null);
  const [apiLoaded, setApiLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const apiKey = import.meta.env?.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

  useEffect(() => {
    if (!apiKey) {
      setLoadError(true);
      return;
    }

    loadGoogleMapsScript(apiKey)
      .then(() => setApiLoaded(true))
      .catch(() => setLoadError(true));
  }, [apiKey]);

  const initAutocomplete = useCallback(() => {
    if (!inputRef.current || !window.google?.maps?.places || autocompleteRef.current) return;

    const autocomplete = new window.google.maps.places.Autocomplete(inputRef.current, {
      componentRestrictions: { country: "ca" },
      fields: ["address_components", "geometry", "formatted_address"],
      types: ["address"],
    });

    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (!place?.address_components) return;

      const address = extractAddressComponents(place);
      onChange(address.formattedAddress);
      onPlaceSelected?.(address);
    });

    autocompleteRef.current = autocomplete;

    // Fix PAC container z-index for dialogs
    const observer = new MutationObserver(() => {
      const pacContainers = document.querySelectorAll(".pac-container");
      pacContainers.forEach((el) => {
        (el as HTMLElement).style.zIndex = "10000";
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, [onChange, onPlaceSelected]);

  useEffect(() => {
    if (apiLoaded) initAutocomplete();
  }, [apiLoaded, initAutocomplete]);

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={loadError ? "Enter address manually" : placeholder}
      required={required}
      className={`w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 ${className}`}
      autoComplete="off"
    />
  );
}
