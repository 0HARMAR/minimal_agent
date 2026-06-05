import "./util/env.js";
import { render } from "ink";
import App from "./app.js";

const { waitUntilExit } = render(<App />);
waitUntilExit();
