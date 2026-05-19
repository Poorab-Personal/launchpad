import React from 'react';
import { hubspot, Text, Flex, Tile } from '@hubspot/ui-extensions';

hubspot.extend(({ context }) => <HelloContactCard context={context} />);

function HelloContactCard({ context }) {
  const portalId = context?.portal?.id;
  const userEmail = context?.user?.email;

  return (
    <Tile>
      <Flex direction="column" gap="small">
        <Text format={{ fontWeight: 'bold' }}>LaunchPad cards — alive on Contact</Text>
        <Text variant="microcopy">
          Portal: {portalId ?? 'unknown'} · Viewing as: {userEmail ?? 'unknown'}
        </Text>
        <Text variant="microcopy">
          Phase-1 smoke card — to be removed after Engagement card is on layouts.
        </Text>
      </Flex>
    </Tile>
  );
}
