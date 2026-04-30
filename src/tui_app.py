"""
Minimal Agent TUI — simple terminal UI with a text input as the main widget.
Run with: python -m src.tui_app
"""
from __future__ import annotations

from textual.app import App, ComposeResult
from textual.widgets import Header, Footer, Input, RichLog
from textual.containers import Container
from textual import events


class AgentTUI(App):
    """A minimal input-driven TUI for the agent."""

    TITLE = "Minimal Agent"
    SUB_TITLE = "type /help for commands"

    CSS = """
    #messages {
        height: 1fr;
        overflow-y: auto;
        background: $surface;
        padding: 1 2;
    }

    #input-container {
        height: auto;
        padding: 1 2;
        border-top: solid $panel;
        background: $surface;
    }

    #prompt {
        border: solid $accent;
        width: 100%;
    }

    #prompt:focus {
        border: solid $accent-lighten-2;
    }
    """

    BINDINGS = [
        ("ctrl+q", "quit", "Quit"),
    ]

    def compose(self) -> ComposeResult:
        yield Header()
        yield RichLog(id="messages", highlight=True, markup=True, wrap=True)
        with Container(id="input-container"):
            yield Input(
                id="prompt",
                placeholder="Type a message and press Enter...",
            )
        yield Footer()

    def on_mount(self) -> None:
        log = self.query_one("#messages", RichLog)
        log.write("[bold cyan]Welcome to Minimal Agent TUI[/bold cyan]")
        log.write("Type [bold]/help[/bold] for available commands or just chat.")
        log.write("")

    def on_input_submitted(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        if not text:
            return

        log = self.query_one("#messages", RichLog)
        log.write(f"[bold green]You:[/bold green] {text}")

        # -- simple command handler (demo) -----------------
        response = self._handle(text)
        log.write(f"[bold blue]Agent:[/bold blue] {response}")
        log.write("")

        event.input.clear()

    def action_quit(self) -> None:
        self.exit()

    # -----------------------------------------------------------
    #  demo command dispatcher — replace with agent integration
    # -----------------------------------------------------------
    def _handle(self, text: str) -> str:
        if text == "/help":
            return (
                "Commands:\n"
                "  /help   — show this message\n"
                "  /clear  — clear the screen\n"
                "  /status — show agent status\n"
                "  /quit   — exit\n"
                "  anything else is echoed (demo)"
            )
        if text == "/clear":
            log = self.query_one("#messages", RichLog)
            log.clear()
            return "Screen cleared."
        if text == "/status":
            return "Agent is [italic]not connected[/italic] (demo mode)."
        if text == "/quit":
            self.exit()
            return "Goodbye!"
        # demo: echo
        return f"[dim](echo)[/dim] {text}"


if __name__ == "__main__":
    app = AgentTUI()
    app.run()
