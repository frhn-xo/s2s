"""Welcome to Reflex! This file outlines the steps to create a basic app."""

import reflex as rx

from rxconfig import config


class State(rx.State):
    """The app state."""

    ...


class Mic(rx.Component):
    library = "/public/components/main"
    tag = "App"

    def add_imports(self):
        return {"react-use-websocket": ["useWebSocket"]}


def index() -> rx.Component:
    return rx.container(
        rx.vstack(
            rx.flex(
                rx.heading("S2S", size="8"),
                rx.color_mode.button(),
                width="100%",
                justify="between",
            ),
            rx.center(
                Mic.create(),
                width="100%",
            ),
            min_height="100vh",
            spacing="7",
        ),
    )


app = rx.App()
app.add_page(index)
