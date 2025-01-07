"""Welcome to Reflex! This file outlines the steps to create a basic app."""

import reflex as rx

from rxconfig import config

from app.components import mic


class State(rx.State):
    """The app state."""

    ...


def index() -> rx.Component:
    return rx.container(
        rx.color_mode.button(position="top-right"),
        rx.vstack(
            rx.heading("S2S", size="9"),
            mic(),
            spacing="5",
            min_height="85vh",
        ),
    )


app = rx.App()
app.add_page(index)
