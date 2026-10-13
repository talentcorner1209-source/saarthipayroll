import { supabase } from "./supabaseClient";

export const API_BASE =
  import.meta.env.VITE_API_BASE_URL || (window.location.hostname === 'localhost' ? 'http://localhost:5000' : '');

export const apiFetch = async (url, options = {}) => {

  const {
    data: { session }
  } = await supabase.auth.getSession();

  const token = session?.access_token;

  if (!token) {
    throw new Error("You are not logged in");
  }

  // File uploads (FormData) must NOT get a Content-Type header:
  // the browser sets it itself, including the multipart boundary.
  const isFormData =
    typeof FormData !== "undefined" && options.body instanceof FormData;

  const headers = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  // If the backend rejects the token (401 invalid/expired access token,
  // 403 OTP gate) and we're not on the login page, treat it as an expired
  // session: clear our markers and redirect to login. /api/login/* calls
  // are excluded because they return 401 for application-level reasons
  // (e.g. "Invalid OTP") that should not log the user out.
  if (
    (response.status === 401 || response.status === 403) &&
    !url.includes("/api/login/") &&
    !window.location.hash.includes("#/login")
  ) {
    console.warn("Session expired or access denied. Redirecting to login.");
    localStorage.removeItem("payroll_keep_signed_in");
    sessionStorage.removeItem("payroll_session_only");
    window.location.hash = "#/login";
    throw new Error("Session expired. Please log in again.");
  }

  return response;
};