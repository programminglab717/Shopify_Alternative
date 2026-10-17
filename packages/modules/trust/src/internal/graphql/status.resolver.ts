import { PublicSite } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import {
  Field,
  GraphQLISODateTime,
  ID,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import { IncidentsService, type IncidentRecord } from '../incidents.service.js';

export enum PlatformIncidentKind {
  INCIDENT = 'INCIDENT',
  MAINTENANCE = 'MAINTENANCE',
}

registerEnumType(PlatformIncidentKind, {
  name: 'PlatformIncidentKind',
  description: 'Something gone wrong at Hatti, or maintenance Hatti planned (BIL-06, ADR-498).',
});

export enum PlatformIncidentImpact {
  DEGRADED = 'DEGRADED',
  OUTAGE = 'OUTAGE',
}

registerEnumType(PlatformIncidentImpact, {
  name: 'PlatformIncidentImpact',
  description: 'How badly what it touches works while it lasts: slow or partly down, or down.',
});

export enum PlatformIncidentStatus {
  INVESTIGATING = 'INVESTIGATING',
  IDENTIFIED = 'IDENTIFIED',
  MONITORING = 'MONITORING',
  RESOLVED = 'RESOLVED',
  SCHEDULED = 'SCHEDULED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

registerEnumType(PlatformIncidentStatus, {
  name: 'PlatformIncidentStatus',
  description:
    "An incident's: INVESTIGATING, IDENTIFIED (its cause found), MONITORING (fixed, watched), " +
    "RESOLVED. Maintenance's: SCHEDULED, IN_PROGRESS, COMPLETED.",
});

export enum PlatformComponent {
  STOREFRONTS = 'STOREFRONTS',
  CHECKOUT = 'CHECKOUT',
  ADMIN = 'ADMIN',
  PAYMENTS = 'PAYMENTS',
  COURIERS = 'COURIERS',
  WHATSAPP = 'WHATSAPP',
  SMS = 'SMS',
  EMAIL = 'EMAIL',
}

registerEnumType(PlatformComponent, {
  name: 'PlatformComponent',
  description: "Hatti's parts, as its status page lists them.",
});

@ObjectType({ description: 'What Hatti said of an incident, at a time.' })
export class PlatformIncidentUpdate {
  @Field(() => PlatformIncidentStatus)
  status!: PlatformIncidentStatus;

  @Field()
  body!: string;

  @Field(() => String, { nullable: true, description: 'The same in Urdu, if Hatti gave it.' })
  bodyUr!: string | null;

  @Field(() => GraphQLISODateTime)
  postedAt!: Date;
}

@ObjectType({ description: 'An incident at Hatti, or maintenance, going on or soon (ADR-498).' })
export class PlatformIncident {
  @Field(() => ID)
  id!: string;

  @Field(() => PlatformIncidentKind)
  kind!: PlatformIncidentKind;

  @Field(() => PlatformIncidentImpact)
  impact!: PlatformIncidentImpact;

  @Field(() => PlatformIncidentStatus)
  status!: PlatformIncidentStatus;

  @Field(() => [PlatformComponent])
  components!: PlatformComponent[];

  @Field()
  title!: string;

  @Field(() => String, { nullable: true, description: 'The same in Urdu, if Hatti gave it.' })
  titleUr!: string | null;

  @Field(() => GraphQLISODateTime, {
    description: 'When it began, or when maintenance is to begin.',
  })
  startsAt!: Date;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When maintenance is to end.',
  })
  endsAt!: Date | null;

  @Field(() => PlatformIncidentUpdate, { description: 'What Hatti said last.' })
  latestUpdate!: PlatformIncidentUpdate;
}

@ObjectType({ description: "Hatti's own status, for the banner in every shop's admin." })
export class PlatformStatus {
  @Field(() => [PlatformIncident], {
    description:
      'Incidents going on, and maintenance going on or beginning within a day, the latest first.',
  })
  incidents!: PlatformIncident[];

  @Field({ description: "Hatti's public status page." })
  statusPageUrl!: string;
}

@Resolver(() => PlatformStatus)
export class StatusResolver {
  constructor(
    private readonly incidents: IncidentsService,
    private readonly site: PublicSite,
  ) {}

  @Query(() => PlatformStatus, {
    description:
      "What is wrong at Hatti now, or planned soon (BIL-06, ADR-498): for every member of a shop's " +
      'staff, whatever their role.',
  })
  async platformStatus(): Promise<PlatformStatus> {
    return {
      incidents: (await this.incidents.current()).map(toIncident),
      statusPageUrl: this.site.url('/status'),
    };
  }
}

function toIncident(record: IncidentRecord): PlatformIncident {
  const latest = record.updates.at(-1)!;
  return {
    id: toPublicId('incident', record.id),
    kind: record.kind.toUpperCase() as PlatformIncidentKind,
    impact: record.impact.toUpperCase() as PlatformIncidentImpact,
    status: record.status.toUpperCase() as PlatformIncidentStatus,
    components: record.components.map((each) => each.toUpperCase() as PlatformComponent),
    title: record.title,
    titleUr: record.titleUr,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    latestUpdate: {
      status: latest.status.toUpperCase() as PlatformIncidentStatus,
      body: latest.body,
      bodyUr: latest.bodyUr,
      postedAt: latest.postedAt,
    },
  };
}
