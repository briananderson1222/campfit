import { ImageResponse } from "next/og";

// Fixes audit finding F-09: no og:image on home or camp pages. This root-segment
// opengraph-image applies site-wide (any route without its own), so social/Twitter
// shares render a branded card instead of a text-only one. Next also reuses it for
// twitter:image. Pure code — no design asset required.

export const alt = "CampFit — Find Kids Camps in Your City";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Brand palette (matches manifest.json / theme).
const PINE = "#1B4332";
const CREAM = "#FEFCF3";
const TERRACOTTA = "#E07856";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          backgroundColor: PINE,
          padding: "80px",
        }}
      >
        <div style={{ display: "flex", fontSize: 96, fontWeight: 700, color: CREAM }}>
          Camp<span style={{ color: TERRACOTTA }}>Fit</span>
        </div>
        <div style={{ marginTop: 24, fontSize: 44, color: CREAM, opacity: 0.85 }}>
          Find kids&apos; camps in your city
        </div>
        <div style={{ marginTop: 16, fontSize: 30, color: CREAM, opacity: 0.6 }}>
          Browse by age, activity, neighborhood &amp; availability
        </div>
      </div>
    ),
    { ...size }
  );
}
