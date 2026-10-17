import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import "./styles.css";
import "./styles/auth.css";
import "./styles/saas.css";
import "./styles/landing.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
