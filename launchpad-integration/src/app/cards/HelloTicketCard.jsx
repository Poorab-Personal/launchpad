import React from 'react';
import { hubspot, Text, Flex, Tile } from '@hubspot/ui-extensions';

hubspot.extend(({ context }) => <HelloTicketCard context={context} />);

function HelloTicketCard({ context }) {
  const portalId = context?.portal?.id;
  const userEmail = context?.user?.email;

  return (
    <Tile>
      <Flex direction="column" gap="small">
        <Text format={{ fontWeight: 'bold' }}>LaunchPad cards — alive on Ticket</Text>
        <Text variant="microcopy">
          Portal: {portalId ?? 'unknown'} · Viewing as: {userEmail ?? 'unknown'}
        </Text>
        <Text variant="microcopy">
          Phase-1 smoke card — to be removed after Ticket BI card is on layouts.
        </Text>
      </Flex>
    </Tile>
  );
}
