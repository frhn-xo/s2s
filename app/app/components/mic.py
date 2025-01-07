import reflex as rx


def mic() -> rx.Component:
    return rx.container(
        rx.button("Microphone"),
    )
