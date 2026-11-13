import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/m",
    name: "grabberX gallery",
    short_name: "gallery",
    description: "Your grabberX library on this phone.",
    start_url: "/m",
    scope: "/m",
    display: "standalone",
    orientation: "any",
    background_color: "#0b0b0c",
    theme_color: "#0b0b0c",
    icons: [
      { src: "/m-icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/m-icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/m-icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
