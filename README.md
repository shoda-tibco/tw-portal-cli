# tw-portal: Transwestern Service Portal CLI

`tw-portal` is a CLI for the [Transwestern Service Portal / Angus](https://www.transwestern.com/angus). It greatly simplifies the process of reserving a car charger time slot.

## Prerequisites

Login credentials to the portal. Email elizabeth.munoz@transwestern.com if you don't have them, let her know you work for Tibco and would like to use the portal.

## Installation

Download the latest release from the releases page for your OS and platform.

## Usage

- Run `tw-portal config` to save your login credentials and car details. These will be saved to `~/.tw-portal/config.json`.

- Run `tw-portal schedule` or just `tw-portal` to see available charging times for the next 14 days that are 2+ hours long and start after 8 a.m. The parameters can be customized with flags, see `tw-portal --help` for details.

```
❯ tw-portal
Transwestern charger availability (Fri, May 29 at 12:00 AM CDT to Fri, Jun 12 at 12:00 AM CDT, 120+ minutes, after 8:00 AM)

Date         Start Time  End Time  Reserve Code
Fri, May 29     3:00 PM   5:00 PM      29668080
Mon, Jun 1      3:00 PM   5:00 PM      29672400
Tue, Jun 2     12:30 PM   5:00 PM      29673690
Tue, Jun 2      3:00 PM   5:00 PM      29673840
Wed, Jun 3     12:30 PM   5:00 PM      29675130
Thu, Jun 4     12:30 PM   5:00 PM      29676570
Thu, Jun 4      3:00 PM   5:00 PM      29676720
Fri, Jun 5     12:30 PM   5:00 PM      29678010
Mon, Jun 8     12:30 PM   5:00 PM      29682330
Mon, Jun 8      1:30 PM   5:00 PM      29682390
Tue, Jun 9     12:30 PM   5:00 PM      29683770
Wed, Jun 10    12:30 PM   5:00 PM      29685210
Thu, Jun 11    11:00 AM   5:00 PM      29686560
Thu, Jun 11    12:30 PM   5:00 PM      29686650
```

- To reserve a time slot, run `tw-portal reserve <reserve_id>`, where `<reserve_id>` is the ID from the schedule output (e.g. `29668080`).

```
❯ tw-portal reserve 29668080
```

This will create a reservation request, and you should get an email confirmation. Next step is to wait for the request to be approved by the building management, which can take a business day or two.


See `tw-portal --help` for more details on flags for manual reservations and filtering.


## Building

Clone this repo, install [bun](https://bun.sh/), and run `bun install` to install dependencies. Then run `bun run all` to build, lint, and typecheck the project. Artifacts will be written to the `dist` folder.
