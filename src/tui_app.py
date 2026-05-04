"""
Minimal Agent TUI — prompt_toolkit + rich demo UI.
Run with: python -m src.tui_app
"""
from __future__ import annotations

import os
import queue
import threading
import time
from datetime import datetime
from typing import Callable

from dotenv import load_dotenv
from prompt_toolkit import PromptSession
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.styles import Style
from prompt_toolkit.completion import WordCompleter
from rich.console import Console
from rich.panel import Panel
from rich.live import Live
from rich.table import Table
from rich.text import Text
from rich import box

from src.agent.orchestrator import Orchestrator

LOG_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "agent.log")


# ── file-based logger (unchanged from original) ──────────────────────────

class LogAPI:
    """Simple file-based logger."""

    def __init__(self, path: str = LOG_FILE) -> None:
        self._path = path
        self._lock = threading.Lock()

    def _write(self, level: str, msg: str) -> None:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{ts}] [{level}] {msg}\n"
        with self._lock:
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(line)

    def info(self, msg: str) -> None:
        self._write("INFO", msg)

    def warn(self, msg: str) -> None:
        self._write("WARN", msg)

    def error(self, msg: str) -> None:
        self._write("ERROR", msg)


# ── prompt_toolkit style ─────────────────────────────────────────────────

PROMPT_STYLE = Style.from_dict({
    "prompt": "bold #00ff87",
    "bottom-toolbar": "bg:#1e1e2e #cdd6f4",
    "bottom-toolbar.running": "bg:#f9e2af #1e1e2e",
})

COMMAND_COMPLETER = WordCompleter(
    ["/help", "/clear", "/stop", "/quit"],
    ignore_case=True,
    sentence=True,
)


# ── TUI class ────────────────────────────────────────────────────────────

class AgentTUI:
    """prompt_toolkit input + rich output TUI for the minimal agent."""

    def __init__(self) -> None:
        self.console = Console()
        self._log = LogAPI()
        self._msg_queue: queue.Queue[str] = queue.Queue()
        self._messages: list[str] = []
        self._running = False
        self._generation = 0
        load_dotenv()

        self._session = PromptSession(
            history=InMemoryHistory(),
            completer=COMMAND_COMPLETER,
            style=PROMPT_STYLE,
        )

    # ── main loop ────────────────────────────────────────────────────

    def run(self) -> None:
        self._print_welcome()
        self._log.info("TUI started")

        while True:
            try:
                text = (
                    self._session.prompt(
                        self._build_prompt(),
                    )
                    .strip()
                )
            except (KeyboardInterrupt, EOFError):
                self.console.print("\n[yellow]Goodbye![/yellow]")
                self._log.info("TUI quit via Ctrl+C/D")
                break

            if not text:
                continue

            self._add_message(f"[bold green]You:[/bold green] {text}")

            if text.startswith("/"):
                self._handle_command(text)
            else:
                self._start_agent(text)

    # ── prompt builders ──────────────────────────────────────────────

    def _build_prompt(self) -> list[tuple[str, str]]:
        if self._running:
            return [("class:prompt", "⟳ ")]
        return [("class:prompt", "> ")]

    # ── messages ─────────────────────────────────────────────────────

    def _add_message(self, msg: str) -> None:
        self._messages.append(msg)

    def _render_messages(self) -> Text:
        """Build rich Text from all accumulated messages."""
        if not self._messages:
            return Text("(no messages yet)", style="dim")
        return Text.from_markup("\n".join(self._messages))

    # ── welcome ──────────────────────────────────────────────────────

    def _print_welcome(self) -> None:
        table = Table(box=box.ROUNDED, border_style="bright_cyan", expand=True)
        table.add_column("[bold cyan]Minimal Agent TUI[/bold cyan]", justify="center")
        table.add_row("Describe a task and press [bold]Enter[/bold] to run the agent.")
        table.add_row("Type [bold]/help[/bold] for commands.")
        self.console.print(table)
        self.console.print()

    # ── commands ─────────────────────────────────────────────────────

    def _handle_command(self, text: str) -> None:
        cmd, _, _ = text[1:].partition(" ")
        self._log.info(f"command: {text}")

        if cmd == "help":
            self.console.print(
                Panel(
                    "Type any task description to run the agent.\n\n"
                    "Commands:\n"
                    "  [bold]/help[/bold]   — show this message\n"
                    "  [bold]/clear[/bold]  — clear message history\n"
                    "  [bold]/stop[/bold]   — stop a running agent\n"
                    "  [bold]/quit[/bold]   — exit\n\n"
                    "Press [bold]Ctrl+C[/bold] or [bold]Ctrl+D[/bold] to exit at any time.",
                    title="Help",
                    border_style="bright_blue",
                    box=box.ROUNDED,
                )
            )
        elif cmd == "clear":
            self._messages.clear()
            self.console.clear()
            self._print_welcome()
        elif cmd == "stop":
            if self._running:
                self._generation += 1
                self._log.warn("agent stop requested")
                self.console.print(
                    "[yellow]Stop requested — will take effect at next iteration.[/yellow]"
                )
            else:
                self.console.print("[dim]No agent is running.[/dim]")
        elif cmd == "quit":
            self._generation += 1
            self._log.info("TUI quit via /quit")
            self.console.print("[yellow]Goodbye![/yellow]")
            raise EOFError
        else:
            self.console.print(f"[red]Unknown command:[/red] /{cmd}. Use /help.")

        self.console.print()

    # ── agent runner ─────────────────────────────────────────────────

    def _start_agent(self, objective: str) -> None:
        self._running = True
        self._generation += 1
        my_gen = self._generation
        self._log.info(f"task: {objective}")

        def emit(msg: str) -> None:
            self._msg_queue.put(msg)

        def agent_done() -> None:
            if self._generation == my_gen:
                self._running = False

        def run_agent() -> None:
            emit("[bold blue]Agent running...[/bold blue]")
            try:
                agent = Orchestrator(
                    project_root=os.getcwd(),
                    objective=objective,
                    max_iterations=5,
                    stream_callback=emit,
                    stop_check=lambda: self._generation != my_gen,
                )
                result = agent.run()
                self._log.info(f"agent done: {result}")
                emit(f"[bold cyan]Done:[/bold cyan] {result}")
            except Exception as exc:
                self._log.error(f"agent error: {exc}")
                emit(f"[bold red]Error:[/bold red] {exc}")
            finally:
                emit("")
                agent_done()

        thread = threading.Thread(target=run_agent, daemon=True)
        thread.start()

        # ── live display while agent runs ────────────────────────
        with Live(
            self._render_messages(),
            console=self.console,
            refresh_per_second=4,
            transient=False,
            vertical_overflow="visible",
        ) as live:
            while thread.is_alive():
                # drain the queue into our message list
                while True:
                    try:
                        msg = self._msg_queue.get_nowait()
                    except queue.Empty:
                        break
                    self._add_message(msg)
                live.update(self._render_messages())
                time.sleep(0.05)

            # final drain
            while True:
                try:
                    msg = self._msg_queue.get_nowait()
                except queue.Empty:
                    break
                self._add_message(msg)
            live.update(self._render_messages())

            self.console.print()  # blank line before next prompt


# ── entry point ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = AgentTUI()
    app.run()
