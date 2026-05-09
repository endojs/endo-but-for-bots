//! endor TUI — skeleton entry point.
//!
//! See `designs/endor-tui.md` for the full design. This skeleton provides
//! the ratatui + crossterm event loop with a placeholder screen and an
//! exit-on-`q` behavior. Chat, inventory, and XS debugger logic are
//! intentionally out of scope for this initial crate commit.

use std::io;
use std::time::Duration;

use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Alignment, Constraint, Direction, Layout},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Terminal,
};

/// Tick rate for the event loop's poll budget.  The TUI redraws only on
/// events (keys, resize); the tick is the upper bound on how long we
/// block waiting for input before checking for other work.
const TICK_RATE: Duration = Duration::from_millis(250);

fn main() -> io::Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let result = run(&mut terminal);

    // Always restore the terminal on exit, even if run() errored.
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture,
    )?;
    terminal.show_cursor()?;

    result
}

fn run<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
) -> io::Result<()> {
    loop {
        terminal.draw(draw)?;

        if event::poll(TICK_RATE)? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    match key.code {
                        KeyCode::Char('q') => return Ok(()),
                        KeyCode::Char('c')
                            if key
                                .modifiers
                                .contains(crossterm::event::KeyModifiers::CONTROL) =>
                        {
                            return Ok(());
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

fn draw(frame: &mut ratatui::Frame) {
    let area = frame.area();

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(area);

    let header = Paragraph::new(Line::from(vec![
        Span::styled("endor", Style::default().add_modifier(Modifier::BOLD)),
        Span::raw(" — not yet implemented"),
    ]))
    .alignment(Alignment::Center)
    .block(Block::default().borders(Borders::ALL).title(" endor TUI "));

    let footer = Paragraph::new(Line::from(vec![
        Span::raw("press "),
        Span::styled("q", Style::default().add_modifier(Modifier::BOLD)),
        Span::raw(" or "),
        Span::styled("Ctrl+C", Style::default().add_modifier(Modifier::BOLD)),
        Span::raw(" to quit"),
    ]))
    .alignment(Alignment::Center);

    frame.render_widget(header, chunks[0]);
    frame.render_widget(footer, chunks[1]);
}
