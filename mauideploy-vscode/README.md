# MAUI Deploy

MAUI Deploy adds a compact VS Code toolbar for building, deploying, and debugging .NET MAUI apps on iOS and Android devices.

## Features

- Select a MAUI project from the current workspace
- Choose Debug or Release configuration from the status bar
- Pick iOS simulators, paired iOS devices, or Android devices
- Build and deploy MAUI apps without leaving VS Code
- Deploy MAUI apps from the existing `bin` output without rebuilding
- Debug MAUI apps with the bundled Mono SDB adapter and experimental XAML Hot Reload on save
- Start a Debug-only experimental `dotnet watch` rebuild/rerun watcher from the status bar
- Pick a `.csproj` from the toolbar and run it with `dotnet test`, using `-c Test` when the project declares a Test configuration
- Ask Copilot to fix captured build errors directly from the build failure notification
- Start a bundled Mono SDB debug adapter for C# debugging
- Open MAUI Deploy logs from the command palette

## Commands

- `MAUI Deploy: Run`
- `MAUI Deploy: Deploy from Bin`
- `MAUI Deploy: Debug`
- `MAUI Deploy: Watch Run (Experimental)`
- `MAUI Deploy: Stop Watch Run`
- `MAUI Deploy: Run Tests`
- `MAUI Deploy: Select Project`
- `MAUI Deploy: Select Device`
- `MAUI Deploy: Toggle Configuration`
- `MAUI Deploy: Ask Copilot to Fix Build Error`
- `MAUI Deploy: Open Logs`

## Requirements

- VS Code 1.85 or newer
- .NET SDK with MAUI workloads installed
- Xcode command line tools for iOS deployment
- Android SDK platform tools for Android deployment

## Source

https://github.com/Vetle444/MauiDeploy